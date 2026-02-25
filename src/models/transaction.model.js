import { getPool } from '../services/database.js';
import { v4 as uuidv4 } from 'uuid';
import { AuditService } from '../services/audit.service.js';
import { ParticipantModel } from './participant.model.js';
import { SettingsModel } from './settings.model.js';
import { sqsService } from '../services/sqs.service.js';

/**
 * Modelo para gestionar transacciones de compra de tickets
 * Maneja los estados: creado -> procesando -> revision -> completado/erroneo
 */
export class TransactionModel {
  
  /**
   * Crear una nueva transacción (estado: creado)
   */
  static async create(transactionData) {
    const pool = getPool();
    const connection = await pool.getConnection();
    
    try {
      // Timeout de 10 segundos para la transacción
      await connection.query('SET SESSION innodb_lock_wait_timeout = 10');
      
      await connection.beginTransaction();
      
      // Generar UUID para la transacción (o usar el proporcionado si viene de SQS)
      const transactionId = transactionData.id || uuidv4();
      
      // Verificar disponibilidad de tickets CON BLOQUEO
      const [ticketType] = await connection.query(
        `SELECT tt.*, r.status as race_status, r.id as race_id 
         FROM ticket_types tt 
         JOIN races r ON tt.race_id = r.id 
         WHERE tt.id = ? AND tt.is_active = TRUE
         FOR UPDATE`,
        [transactionData.ticket_type_id]
      );
      
      if (!ticketType || ticketType.length === 0) {
        throw new Error('Tipo de ticket no disponible');
      }
      
      const ticket = ticketType[0];
      
      // Validar disponibilidad ANTES de insertar
      const availableNow = ticket.available_quantity - ticket.sold_quantity;
      if (availableNow < transactionData.quantity) {
        throw new Error(`Solo quedan ${availableNow} tickets disponibles (solicitaste ${transactionData.quantity})`);
      }
      
      if (ticket.race_status !== 'published') {
        throw new Error('La carrera no está disponible para compra');
      }
      
      // Calcular monto total
      const totalAmount = ticket.price * transactionData.quantity;
      
      // Crear historial de estado inicial
      const statusHistory = JSON.stringify([{
        status: 'creado',
        timestamp: new Date().toISOString(),
        note: 'Transacción creada desde formulario'
      }]);
      
      // Insertar transacción
      const [result] = await connection.query(
        `INSERT INTO transactions (
          id, race_id, ticket_type_id, quantity,
          buyer_name, buyer_email, buyer_phone, buyer_dni, buyer_data,
          total_amount, currency, status, status_history,
          ip_address, user_agent, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transactionId,
          ticket.race_id,
          transactionData.ticket_type_id,
          transactionData.quantity,
          transactionData.buyer_name,
          transactionData.buyer_email,
          transactionData.buyer_phone || null,
          transactionData.buyer_dni || null,
          JSON.stringify(transactionData.buyer_data || {}),
          totalAmount,
          ticket.currency,
          'creado',
          statusHistory,
          transactionData.ip_address || null,
          transactionData.user_agent || null,
          JSON.stringify(transactionData.metadata || {})
        ]
      );
      
      console.log(`📝 Transacción ${transactionId} creada, reservando ${transactionData.quantity} tickets...`);
      
      // Reservar tickets (incrementar sold_quantity CON VALIDACIÓN)
      const [updateResult] = await connection.query(
        `UPDATE ticket_types 
         SET sold_quantity = sold_quantity + ? 
         WHERE id = ? AND (sold_quantity + ?) <= available_quantity`,
        [transactionData.quantity, transactionData.ticket_type_id, transactionData.quantity]
      );
      
      // CRÍTICO: Verificar que se actualizó una fila
      if (updateResult.affectedRows === 0) {
        await AuditService.logCriticalError('ticket_type', transactionData.ticket_type_id, 
          new Error('Sobreventa detectada'), 
          { 
            transaction_id: transactionId,
            requested_quantity: transactionData.quantity,
            available: availableNow
          }
        );
        throw new Error('No se pudieron reservar los tickets (posible sobreventa detectada)');
      }
      
      // Registrar reserva en auditoría
      await AuditService.logTicketReservation(
        transactionData.ticket_type_id, 
        transactionData.quantity, 
        transactionId,
        transactionData.ip_address
      );
      
      console.log(`✅ ${transactionData.quantity} tickets reservados exitosamente para transacción ${transactionId}`);
      
      await connection.commit();
      
      // Obtener transacción creada
      return await this.findById(transactionId);
      
    } catch (error) {
      await connection.rollback();
      console.error(`❌ Error creando transacción: ${error.message}`);
      
      // Registrar error crítico
      if (transactionId) {
        await AuditService.logCriticalError('transaction', transactionId, error, {
          operation: 'create',
          buyer_email: transactionData.buyer_email
        });
      }
      
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * Buscar transacción por ID
   */
  static async findById(transactionId) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT t.*, 
              r.name as race_name, r.event_date,
              tt.name as ticket_type_name, tt.price as unit_price
       FROM transactions t
       JOIN races r ON t.race_id = r.id
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       WHERE t.id = ?`,
      [transactionId]
    );
    
    if (rows.length === 0) return null;
    
    // Parsear campos JSON
    const transaction = rows[0];
    transaction.buyer_data = JSON.parse(transaction.buyer_data || '{}');
    transaction.status_history = JSON.parse(transaction.status_history || '[]');
    transaction.metadata = JSON.parse(transaction.metadata || '{}');
    transaction.payment_gateway_response = JSON.parse(transaction.payment_gateway_response || '{}');
    
    return transaction;
  }
  
  /**
   * Actualizar estado de la transacción (con optimistic locking)
   */
  static async updateStatus(transactionId, newStatus, additionalData = {}) {
    const pool = getPool();
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // Obtener transacción actual con bloqueo
      const [rows] = await connection.query(
        'SELECT * FROM transactions WHERE id = ? FOR UPDATE',
        [transactionId]
      );
      
      if (rows.length === 0) {
        throw new Error('Transacción no encontrada');
      }
      
      const transaction = rows[0];
      const currentStatusHistory = JSON.parse(transaction.status_history || '[]');
      
      // Validar transición de estado
      this._validateStatusTransition(transaction.status, newStatus);
      
      // Agregar al historial
      currentStatusHistory.push({
        from: transaction.status,
        to: newStatus,
        timestamp: new Date().toISOString(),
        note: additionalData.note || null,
        metadata: additionalData.metadata || null
      });
      
      // Preparar campos adicionales según el estado
      const updates = {
        status: newStatus,
        status_history: JSON.stringify(currentStatusHistory),
        version: transaction.version + 1
      };
      
      if (newStatus === 'procesando') {
        updates.processed_at = new Date();
        updates.payment_gateway = additionalData.payment_gateway || null;
      }
      
      if (newStatus === 'completado') {
        updates.completed_at = new Date();
      }
      
      if (additionalData.payment_gateway_transaction_id) {
        updates.payment_gateway_transaction_id = additionalData.payment_gateway_transaction_id;
      }
      
      if (additionalData.payment_gateway_response) {
        updates.payment_gateway_response = JSON.stringify(additionalData.payment_gateway_response);
      }
      
      if (additionalData.payment_method) {
        updates.payment_method = additionalData.payment_method;
      }
      
      // Construir query dinámicamente
      const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
      const values = Object.values(updates);
      
      const [updateResult] = await connection.query(
        `UPDATE transactions SET ${setClause} WHERE id = ? AND version = ?`,
        [...values, transactionId, transaction.version]
      );
      
      // CRÍTICO: Verificar optimistic locking
      if (updateResult.affectedRows === 0) {
        await AuditService.logCriticalError('transaction', transactionId,
          new Error('Conflicto de versión optimista'),
          { 
            attempted_transition: `${transaction.status} -> ${newStatus}`,
            expected_version: transaction.version
          }
        );
        throw new Error('Conflicto de versión: la transacción fue modificada por otro proceso. Intenta de nuevo.');
      }
      
      // Registrar cambio de estado en auditoría
      await AuditService.logTransactionStatusChange(
        transactionId,
        transaction.status,
        newStatus,
        { note: additionalData.note, version: updates.version }
      );
      
      console.log(`📝 Transacción ${transactionId} actualizada: ${transaction.status} -> ${newStatus}`);
      
      // ========================================================================
      // ESTADO: REVISION - Generar números de corredor y encolar notificación
      // ========================================================================
      if (newStatus === 'revision') {
        try {
          console.log(`🎫 Generando números de corredor para transacción ${transactionId}...`);
          
          // 1. Obtener configuración del ticket_type y último número
          const bibInfo = await ParticipantModel.getLastBibNumber(
            transaction.race_id, 
            transaction.ticket_type_id,
            connection
          );
          
          // 2. Extraer participantes de buyer_data
          const buyerData = JSON.parse(transaction.buyer_data || '{}');
          let participants = buyerData.participants || [];
          
          if (participants.length === 0) {
            // Si no hay participants array, crear uno con los datos del comprador
            participants = [{
              first_name: transaction.buyer_name.split(' ')[0],
              last_name: transaction.buyer_name.split(' ').slice(1).join(' '),
              email: transaction.buyer_email,
              phone: transaction.buyer_phone,
              dni: transaction.buyer_dni
            }];
          }
          
          // 3. Generar números de corredor consecutivos
          const startBib = bibInfo.lastBib + 1;
          const padding = bibInfo.padding;
          const createdParticipants = [];
          
          for (let i = 0; i < participants.length; i++) {
            const bibNumber = String(startBib + i).padStart(padding, '0');
            const participant = participants[i];
            
            // Crear participante en BD (usando la misma conexión de la transacción)
            const participantData = {
              transaction_id: transactionId,
              race_id: transaction.race_id,
              bib_number: bibNumber,
              first_name: participant.first_name,
              last_name: participant.last_name,
              email: participant.email,
              phone: participant.phone,
              dni: participant.dni,
              tshirt_size: participant.tshirt_size,
              emergency_contact: participant.emergency_contact,
              emergency_phone: participant.emergency_phone
            };
            
            await ParticipantModel.create(participantData, connection);
            createdParticipants.push({ ...participant, bib_number: bibNumber });
            
            console.log(`✅ Participante ${participant.first_name} ${participant.last_name} - Número: ${bibNumber}`);
          }
          
          // 4. Encolar notificación de email
          if (sqsService.enabled) {
            await sqsService.sendMessage('notifications', {
              type: 'payment_confirmed',
              data: {
                transaction_id: transactionId,
                buyer_email: transaction.buyer_email,
                buyer_name: transaction.buyer_name,
                race_id: transaction.race_id,
                participants: createdParticipants
              }
            });
            console.log(`📧 Email de confirmación encolado para ${transaction.buyer_email}`);
          }
          
          // 5. Verificar si debe auto-completarse
          const autoComplete = await SettingsModel.isAutoCompleteEnabled();
          if (autoComplete) {
            console.log(`⚡ Auto-complete habilitado, pasando a estado completado...`);
            
            // Actualizar a completado (recursivo, pero con control de versión)
            const [autoCompleteResult] = await connection.query(
              `UPDATE transactions 
               SET status = 'completado', 
                   completed_at = NOW(),
                   version = version + 1
               WHERE id = ? AND version = ?`,
              [transactionId, updates.version]
            );
            
            if (autoCompleteResult.affectedRows > 0) {
              // Incrementar participantes de la carrera
              await connection.query(
                `UPDATE races 
                 SET current_participants = current_participants + ? 
                 WHERE id = ?`,
                [transaction.quantity, transaction.race_id]
              );
              
              console.log(`✅ Transacción auto-completada: ${transactionId}`);
            }
          }
        } catch (error) {
          console.error(`❌ Error generando participantes para transacción ${transactionId}:`, error);
          await AuditService.logCriticalError('transaction', transactionId, error, {
            step: 'participant_generation',
            race_id: transaction.race_id,
            ticket_type_id: transaction.ticket_type_id
          });
          // No lanzar error, solo registrar - la transacción quedará en revisión
          // y se pueden generar los participantes manualmente después
        }
      }
      
      // ========================================================================
      // ESTADO: COMPLETADO - Incrementar participantes de la carrera
      // ========================================================================
      if (newStatus === 'completado') {
        await connection.query(
          `UPDATE races 
           SET current_participants = current_participants + ? 
           WHERE id = ?`,
          [transaction.quantity, transaction.race_id]
        );
        console.log(`✅ ${transaction.quantity} participantes agregados a carrera ${transaction.race_id}`);
      }
      
      // Si el estado es erroneo o cancelado, liberar tickets
      if (newStatus === 'erroneo' || newStatus === 'cancelado') {
        const [releaseResult] = await connection.query(
          `UPDATE ticket_types 
           SET sold_quantity = sold_quantity - ? 
           WHERE id = ? AND sold_quantity >= ?`,
          [transaction.quantity, transaction.ticket_type_id, transaction.quantity]
        );
        
        if (releaseResult.affectedRows === 0) {
          console.warn(`⚠️  No se pudieron liberar ${transaction.quantity} tickets del tipo ${transaction.ticket_type_id}`);
        } else {
          // Registrar liberación en auditoría
          await AuditService.logTicketRelease(
            transaction.ticket_type_id,
            transaction.quantity,
            transactionId,
            newStatus
          );
          console.log(`🔓 ${transaction.quantity} tickets liberados (transacción ${newStatus})`);
        }
      }
      
      await connection.commit();
      
      return await this.findById(transactionId);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * Validar transición de estados
   */
  static _validateStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      'creado': ['procesando', 'cancelado'],
      'procesando': ['revision', 'erroneo', 'cancelado'],
      'revision': ['completado', 'erroneo'],
      'completado': [],
      'erroneo': [],
      'cancelado': []
    };
    
    if (!validTransitions[currentStatus]) {
      throw new Error(`Estado actual inválido: ${currentStatus}`);
    }
    
    if (!validTransitions[currentStatus].includes(newStatus)) {
      throw new Error(
        `Transición inválida: ${currentStatus} -> ${newStatus}. ` +
        `Transiciones válidas: ${validTransitions[currentStatus].join(', ')}`
      );
    }
  }
  
  /**
   * Listar transacciones con filtros
   */
  static async findAll(filters = {}, pagination = { page: 1, limit: 50 }) {
    const pool = getPool();
    
    const conditions = [];
    const params = [];
    
    if (filters.status) {
      conditions.push('t.status = ?');
      params.push(filters.status);
    }
    
    if (filters.race_id) {
      conditions.push('t.race_id = ?');
      params.push(filters.race_id);
    }
    
    if (filters.buyer_email) {
      conditions.push('t.buyer_email = ?');
      params.push(filters.buyer_email);
    }
    
    if (filters.payment_gateway_transaction_id) {
      conditions.push('t.payment_gateway_transaction_id = ?');
      params.push(filters.payment_gateway_transaction_id);
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const offset = (pagination.page - 1) * pagination.limit;
    
    const [rows] = await pool.query(
      `SELECT t.id, t.race_id, t.status, t.buyer_name, t.buyer_email,
              t.total_amount, t.currency, t.quantity, t.created_at, t.updated_at,
              r.name as race_name, tt.name as ticket_type_name
       FROM transactions t
       JOIN races r ON t.race_id = r.id
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.limit, offset]
    );
    
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM transactions t ${whereClause}`,
      params
    );
    
    return {
      data: rows,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / pagination.limit)
      }
    };
  }

  /**
   * Buscar transacciones abandonadas (en "procesando" más tiempo del permitido)
   * @param {number} timeoutMinutes - Minutos después de los cuales se considera abandonada
   * @returns {Array} Lista de transacciones abandonadas
   */
  static async findAbandoned(timeoutMinutes = 30) {
    const pool = getPool();
    
    const [rows] = await pool.query(`
      SELECT t.*, 
             TIMESTAMPDIFF(MINUTE, t.processed_at, NOW()) as minutes_elapsed,
             r.name as race_name, 
             tt.name as ticket_type_name
      FROM transactions t
      JOIN races r ON t.race_id = r.id
      JOIN ticket_types tt ON t.ticket_type_id = tt.id
      WHERE t.status = 'procesando'
        AND t.processed_at IS NOT NULL
        AND TIMESTAMPDIFF(MINUTE, t.processed_at, NOW()) >= ?
      ORDER BY t.processed_at ASC
    `, [timeoutMinutes]);

    return rows;
  }

  /**
   * Cancelar una transacción y liberar sus tickets
   * @param {string} transactionId - UUID de la transacción
   * @param {string} reason - Razón de la cancelación
   * @returns {Object} Transacción actualizada
   */
  static async cancel(transactionId, reason = 'Cancelación manual') {
    const pool = getPool();
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();

      // Obtener transacción con bloqueo
      const [rows] = await connection.query(
        'SELECT * FROM transactions WHERE id = ? FOR UPDATE',
        [transactionId]
      );

      if (rows.length === 0) {
        throw new Error('Transacción no encontrada');
      }

      const transaction = rows[0];

      // Validar que se puede cancelar
      if (!['creado', 'procesando'].includes(transaction.status)) {
        throw new Error(`No se puede cancelar una transacción en estado "${transaction.status}"`);
      }

      // Liberar tickets si están reservados
      if (transaction.quantity > 0) {
        await connection.query(`
          UPDATE ticket_types
          SET sold_quantity = GREATEST(0, sold_quantity - ?)
          WHERE id = ?
        `, [transaction.quantity, transaction.ticket_type_id]);

        await AuditService.logTicketRelease(
          transaction.ticket_type_id,
          transaction.quantity,
          transactionId,
          reason
        );
      }

      // Actualizar transacción a cancelado
      await this.updateStatus(transactionId, 'cancelado', {
        note: reason,
        metadata: { cancelled_at: new Date().toISOString() }
      });

      await connection.commit();

      console.log(`✅ Transacción ${transactionId} cancelada: ${reason}`);
      
      return await this.findById(transactionId);

    } catch (error) {
      await connection.rollback();
      console.error(`❌ Error cancelando transacción ${transactionId}:`, error.message);
      throw error;
    } finally {
      connection.release();
    }
  }
}
