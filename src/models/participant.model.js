import { getPool } from '../services/database.js';
import { v4 as uuidv4 } from 'uuid';
import { logInfo, logError } from '../utils/logger.js';

/**
 * Modelo para gestionar participantes de carreras
 * Maneja números de corredor, entrega de kits y datos personales
 */
export class ParticipantModel {
  
  /**
   * Crear un nuevo participante
   * @param {Object} participantData - Datos del participante
   * @param {Object} connection - Conexión opcional de base de datos
   * @returns {Promise<Object>} - Participante creado
   */
  static async create(participantData, connection = null) {
    const pool = connection || getPool();
    const participantId = participantData.id || uuidv4();
    
    try {
      await pool.query(
        `INSERT INTO race_participants (
          id, transaction_id, race_id, bib_number,
          first_name, last_name, email, phone, dni,
          tshirt_size, emergency_contact, emergency_phone
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          participantId,
          participantData.transaction_id,
          participantData.race_id,
          participantData.bib_number,
          participantData.first_name,
          participantData.last_name,
          participantData.email,
          participantData.phone || null,
          participantData.dni || null,
          participantData.tshirt_size || null,
          participantData.emergency_contact || null,
          participantData.emergency_phone || null
        ]
      );
      
      await logInfo('participant', 'Participante creado', participantId, {
        bib_number: participantData.bib_number,
        race_id: participantData.race_id
      });
      
      return await this.findById(participantId);
      
    } catch (error) {
      await logError('participant', 'Error al crear participante', participantId, {
        error: error.message,
        bib_number: participantData.bib_number
      });
      throw error;
    }
  }
  
  /**
   * Buscar participante por ID
   */
  static async findById(participantId) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM race_participants WHERE id = ?',
      [participantId]
    );
    return rows[0] || null;
  }
  
  /**
   * Obtener todos los participantes de una transacción
   */
  static async findByTransactionId(transactionId) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT p.*, r.title as race_title, r.start_date as race_date
       FROM race_participants p
       JOIN races r ON p.race_id = r.id
       WHERE p.transaction_id = ?
       ORDER BY p.bib_number ASC`,
      [transactionId]
    );
    return rows;
  }
  
  /**
   * Obtener todos los participantes de una carrera
   */
  static async findByRaceId(raceId, options = {}) {
    const pool = getPool();
    let query = `
      SELECT p.*, t.status as transaction_status
      FROM race_participants p
      JOIN transactions t ON p.transaction_id = t.id
      WHERE p.race_id = ?
    `;
    
    const params = [raceId];
    
    // Filtrar solo participantes con transacciones completadas
    if (options.onlyCompleted) {
      query += ` AND t.status = 'completado'`;
    }
    
    query += ` ORDER BY p.bib_number ASC`;
    
    if (options.limit) {
      query += ` LIMIT ?`;
      params.push(options.limit);
    }
    
    const [rows] = await pool.query(query, params);
    return rows;
  }
  
  /**
   * Obtener el último número de corredor asignado para un ticket_type
   * Usa FOR UPDATE para evitar colisiones en asignaciones concurrentes
   */
  static async getLastBibNumber(raceId, ticketTypeId, connection = null) {
    const pool = connection || getPool();
    
    // Aumentar timeout para el FOR UPDATE (30 segundos)
    if (connection) {
      await connection.query('SET SESSION innodb_lock_wait_timeout = 30');
    }
    
    // Obtener configuración del tipo de ticket (rango mín/máx)
    const [ticketType] = await pool.query(
      `SELECT bib_number_start, bib_number_end
       FROM ticket_types 
       WHERE id = ?`,
      [ticketTypeId]
    );
    
    if (!ticketType || ticketType.length === 0) {
      throw new Error('Tipo de ticket no encontrado');
    }
    
    const startNumber = (ticketType[0].bib_number_start > 0 ? ticketType[0].bib_number_start : null) ?? 1;
    const endNumber   = ticketType[0].bib_number_end ?? null;
    
    // Calcular padding automáticamente desde bib_number_end
    // Si end=1000 → 4 dígitos → '0001'. Si null, usar 4 por defecto.
    const padding = endNumber
      ? String(endNumber).length
      : String(startNumber).length > 4 ? String(startNumber).length : 4;
    
    // Obtener el último número asignado para este ticket_type CON LOCK
    const [result] = await pool.query(
      `SELECT COALESCE(MAX(CAST(rp.bib_number AS UNSIGNED)), ?) as last_bib
       FROM race_participants rp
       JOIN transactions t ON rp.transaction_id = t.id
       WHERE rp.race_id = ?
         AND t.ticket_type_id = ?
       FOR UPDATE`,
      [startNumber - 1, raceId, ticketTypeId]
    );
    
    const lastBib = result[0].last_bib;
    const nextBib = lastBib + 1;
    
    // Validar que no se exceda el rango máximo
    if (endNumber !== null && nextBib > endNumber) {
      throw new Error(
        `Rango de números de corredor agotado para este tipo de ticket ` +
        `(${startNumber}-${endNumber}). No quedan números disponibles.`
      );
    }
    
    return {
      lastBib,
      padding,
      startNumber,
      endNumber,
      available: endNumber !== null ? endNumber - lastBib : null
    };
  }
  
  /**
   * Marcar kit como entregado
   */
  static async markKitDelivered(participantId, deliveredBy) {
    const pool = getPool();
    
    await pool.query(
      `UPDATE race_participants 
       SET kit_delivered = TRUE, 
           kit_delivered_at = NOW(),
           kit_delivered_by = ?
       WHERE id = ?`,
      [deliveredBy, participantId]
    );
    
    await logInfo('participant', 'Kit entregado', participantId, {
      delivered_by: deliveredBy
    });
    
    return await this.findById(participantId);
  }
  
  /**
   * Registrar tiempo de llegada
   */
  static async recordFinishTime(participantId, finishTime) {
    const pool = getPool();
    
    const [participant] = await pool.query(
      'SELECT start_time FROM race_participants WHERE id = ?',
      [participantId]
    );
    
    if (!participant[0]?.start_time) {
      throw new Error('No hay hora de inicio registrada');
    }
    
    // Calcular tiempo oficial
    const startTime = new Date(participant[0].start_time);
    const endTime = new Date(finishTime);
    const officialTime = new Date(endTime - startTime);
    
    await pool.query(
      `UPDATE race_participants 
       SET finish_time = ?,
           official_time = ?
       WHERE id = ?`,
      [finishTime, officialTime.toISOString().substr(11, 8), participantId]
    );
    
    return await this.findById(participantId);
  }
  
  /**
   * Obtener estadísticas de una carrera
   */
  static async getRaceStats(raceId) {
    const pool = getPool();
    
    const [stats] = await pool.query(
      `SELECT 
        COUNT(*) as total_participants,
        SUM(CASE WHEN kit_delivered = TRUE THEN 1 ELSE 0 END) as kits_delivered,
        SUM(CASE WHEN finish_time IS NOT NULL THEN 1 ELSE 0 END) as finishers,
        MIN(official_time) as best_time,
        AVG(official_time) as avg_time
       FROM race_participants p
       JOIN transactions t ON p.transaction_id = t.id
       WHERE p.race_id = ? AND t.status = 'completado'`,
      [raceId]
    );
    
    return stats[0];
  }
}
