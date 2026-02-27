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
      
      // logInfo en try-catch: no debe romper la creación si falla
      try {
        await logInfo('participant', 'Participante creado', participantId, {
          bib_number: participantData.bib_number,
          race_id: participantData.race_id
        });
      } catch (logErr) {
        console.warn(`⚠️  Error en log de participante ${participantId}:`, logErr.message);
      }
      
      // NO hacer findById aquí: si estamos dentro de una transacción,
      // la fila aún no tiene commit y otra conexión no la verá.
      // Retornar los datos directamente.
      return { id: participantId, ...participantData };
      
    } catch (error) {
      // logError en try-catch: no debe enmascarar el error original
      try {
        await logError('participant', 'Error al crear participante', participantId, {
          error: error.message,
          bib_number: participantData.bib_number
        });
      } catch (logErr) {
        console.warn(`⚠️  Error en logError de participante:`, logErr.message);
      }
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
      `SELECT p.*, r.name as race_title, r.event_date as race_date
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
    
    // 1. Obtener TODA la configuración del ticket_type en una sola query
    //    bib_number_end puede no existir (migración 08), se maneja con fallback
    let ticketTypeConfig;
    try {
      const [rows] = await pool.query(
        `SELECT bib_number_start, bib_number_padding, bib_number_end
         FROM ticket_types 
         WHERE id = ?`,
        [ticketTypeId]
      );
      ticketTypeConfig = rows[0];
    } catch (e) {
      // Si bib_number_end no existe, consultar sin ella
      const [rows] = await pool.query(
        `SELECT bib_number_start, bib_number_padding
         FROM ticket_types 
         WHERE id = ?`,
        [ticketTypeId]
      );
      ticketTypeConfig = rows[0];
      console.warn(`⚠️  bib_number_end no disponible, usando sin límite`);
    }
    
    if (!ticketTypeConfig) {
      throw new Error('Tipo de ticket no encontrado');
    }
    
    const startNumber = (ticketTypeConfig.bib_number_start > 0 ? ticketTypeConfig.bib_number_start : null) ?? 1;
    const endNumber = ticketTypeConfig.bib_number_end ?? null;
    
    // 2. Calcular padding: usar bib_number_padding de BD o calcularlo automáticamente
    let padding = (ticketTypeConfig.bib_number_padding > 0)
      ? ticketTypeConfig.bib_number_padding
      : null;
    if (!padding) {
      padding = endNumber
        ? String(endNumber).length
        : String(startNumber).length > 4 ? String(startNumber).length : 4;
    }
    
    // 3. Obtener el último bib_number asignado para este ticket_type
    //    SIN FOR UPDATE — la serialización de bib numbers se hace con
    //    advisory lock (GET_LOCK) en transaction.model.js
    //    Solo contar participantes de transacciones VÁLIDAS (revision/completado),
    //    no de transacciones erroneas/canceladas que dejaron ghost records
    const [lastRows] = await pool.query(
      `SELECT rp.bib_number
       FROM race_participants rp
       WHERE rp.race_id = ?
         AND rp.transaction_id IN (
           SELECT id FROM transactions
           WHERE ticket_type_id = ?
             AND status IN ('revision', 'completado')
         )
       ORDER BY CAST(rp.bib_number AS UNSIGNED) DESC
       LIMIT 1`,
      [raceId, ticketTypeId]
    );
    
    const lastBib = lastRows.length > 0
      ? Number(lastRows[0].bib_number)
      : startNumber - 1;
    
    const nextBib = lastBib + 1;
    
    // 4. Validar que no se exceda el rango máximo
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
