import { getPool } from '../services/database.js';
import { v4 as uuidv4 } from 'uuid';
import { logInfo, logError, logWarning } from '../utils/logger.js';

/**
 * Modelo para gestionar transacciones de compra de tickets
 * Versión simplificada para el Worker (solo operaciones de escritura)
 */
export class TransactionModel {
  
  /**
   * Crear una nueva transacción (estado: creado)
   */
  static async create(transactionData) {
    const pool = getPool();
    const connection = await pool.getConnection();
    
    try {
      // Timeout reducido ya que no usamos SELECT FOR UPDATE
      // Solo el UPDATE atómico necesita un lock breve
      await connection.query('SET SESSION innodb_lock_wait_timeout = 5');
      
      await connection.beginTransaction();
      
      // Generar UUID para la transacción (o usar el proporcionado si viene de SQS)
      const transactionId = transactionData.id || uuidv4();
      
      // Verificar disponibilidad de tickets SIN BLOQUEO (optimista)
      // El bloqueo real ocurrirá en el UPDATE atómico más adelante
      const [ticketType] = await connection.query(
        `SELECT tt.*, r.status as race_status, r.id as race_id 
         FROM ticket_types tt 
         JOIN races r ON tt.race_id = r.id 
         WHERE tt.id = ? AND tt.is_active = TRUE`,
        [transactionData.ticket_type_id]
      );
      
      if (!ticketType || ticketType.length === 0) {
        throw new Error('Tipo de ticket no disponible');
      }
      
      const ticket = ticketType[0];
      
      // Validación optimista (puede cambiar antes del UPDATE, pero el UPDATE validará)
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
        note: 'Transacción creada vía SQS Worker'
      }]);
      
      // Insertar transacción
      await connection.query(
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
      
      // ACTUALIZACIÓN ATÓMICA: Reservar tickets solo si hay disponibilidad
      // Este UPDATE es el único punto de bloqueo, pero es muy breve (milisegundos)
      // Si múltiples workers intentan actualizar simultáneamente, solo uno tendrá éxito
      const [updateResult] = await connection.query(
        `UPDATE ticket_types 
         SET sold_quantity = sold_quantity + ? 
         WHERE id = ? AND (sold_quantity + ?) <= available_quantity`,
        [transactionData.quantity, transactionData.ticket_type_id, transactionData.quantity]
      );
      
      // CRÍTICO: Verificar que se actualizó una fila
      if (updateResult.affectedRows === 0) {
        // Otro worker se adelantó o no hay tickets suficientes
        await logError('ticket_type', 'No se pudieron reservar tickets (posible sobreventa o race condition)', transactionData.ticket_type_id, { 
          transaction_id: transactionId,
          requested_quantity: transactionData.quantity
        });
        throw new Error('No hay tickets suficientes disponibles en este momento. Por favor, intenta nuevamente.');
      }
      
      await logInfo('transaction', 'Transacción creada vía SQS', transactionId, { 
        ticket_type_id: transactionData.ticket_type_id,
        quantity: transactionData.quantity 
      });
      
      console.log(`✅ ${transactionData.quantity} tickets reservados exitosamente para transacción ${transactionId}`);
      
      await connection.commit();
      
      // Devolver objeto con datos básicos
      return {
        id: transactionId,
        race_id: ticket.race_id,
        ticket_type_id: transactionData.ticket_type_id,
        quantity: transactionData.quantity,
        total_amount: totalAmount,
        currency: ticket.currency,
        status: 'creado'
      };
      
    } catch (error) {
      await connection.rollback();
      console.error(`❌ Error creando transacción: ${error.message}`);
      
      if (transactionData.id) {
        await logError('transaction', 'Error al crear transacción vía SQS', transactionData.id, { 
          error: error.message,
          ticket_type_id: transactionData.ticket_type_id,
          quantity: transactionData.quantity
        });
      }
      
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * Actualizar estado de la transacción
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
        await logError('transaction', 'Conflicto de versión optimista', transactionId, { 
          attempted_transition: `${transaction.status} -> ${newStatus}`,
          expected_version: transaction.version
        });
        throw new Error('Conflicto de versión: la transacción fue modificada por otro proceso.');
      }
      
      await logInfo('transaction', `Estado actualizado: ${transaction.status} -> ${newStatus}`, transactionId);
      
      console.log(`📝 Transacción ${transactionId} actualizada: ${transaction.status} -> ${newStatus}`);
      
      // Si el estado es completado, incrementar participantes de la carrera
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
           SET sold_quantity = GREATEST(0, sold_quantity - ?)
           WHERE id = ? AND sold_quantity >= ?`,
          [transaction.quantity, transaction.ticket_type_id, transaction.quantity]
        );
        
        if (releaseResult.affectedRows === 0) {
          await logWarning('ticket_type', 'No se pudieron liberar tickets', transaction.ticket_type_id, {
            transaction_id: transactionId,
            quantity: transaction.quantity
          });
        } else {
          await logInfo('ticket_type', 'Tickets liberados', transaction.ticket_type_id, {
            transaction_id: transactionId,
            quantity: transaction.quantity,
            reason: newStatus
          });
          console.log(`🔓 ${transaction.quantity} tickets liberados (transacción ${newStatus})`);
        }
      }
      
      await connection.commit();
      
      return {
        id: transactionId,
        status: newStatus,
        updated_at: new Date()
      };
      
    } catch (error) {
      await connection.rollback();
      console.error(`❌ Error actualizando transacción ${transactionId}:`, error.message);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Marcar transacción como pagada
   */
  static async markAsPaid(transactionId, paymentData) {
    return await this.updateStatus(transactionId, 'completado', {
      payment_gateway_transaction_id: paymentData.transactionId || paymentData.payment_gateway_transaction_id,
      payment_method: paymentData.payment_method || 'paypal',
      payment_gateway_response: paymentData.response || paymentData,
      note: 'Pago confirmado'
    });
  }

  /**
   * Actualizar datos de la transacción
   */
  static async update(transactionId, updateData) {
    const pool = getPool();
    
    try {
      const fields = [];
      const values = [];
      
      if (updateData.buyer_name) {
        fields.push('buyer_name = ?');
        values.push(updateData.buyer_name);
      }
      
      if (updateData.buyer_email) {
        fields.push('buyer_email = ?');
        values.push(updateData.buyer_email);
      }
      
      if (updateData.buyer_phone) {
        fields.push('buyer_phone = ?');
        values.push(updateData.buyer_phone);
      }
      
      if (updateData.buyer_dni) {
        fields.push('buyer_dni = ?');
        values.push(updateData.buyer_dni);
      }
      
      if (updateData.buyer_data) {
        fields.push('buyer_data = ?');
        values.push(JSON.stringify(updateData.buyer_data));
      }
      
      if (fields.length === 0) {
        throw new Error('No hay datos para actualizar');
      }
      
      fields.push('updated_at = NOW()');
      values.push(transactionId);
      
      await pool.query(
        `UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`,
        values
      );
      
      await logInfo('transaction', 'Datos actualizados', transactionId, { fields: Object.keys(updateData) });
      
      return { id: transactionId, updated: true };
      
    } catch (error) {
      console.error(`❌ Error actualizando transacción ${transactionId}:`, error.message);
      throw error;
    }
  }
}
