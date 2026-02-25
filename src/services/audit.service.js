import { getPool } from './database.js';

/**
 * Servicio de auditoría para trazabilidad de operaciones críticas
 * Registra todas las operaciones relacionadas con ventas de tickets
 */
export class AuditService {
  
  /**
   * Registrar evento de auditoría
   * @param {Object} auditData - Datos del evento
   * @param {string} auditData.entity_type - Tipo de entidad (transaction, ticket_type, race)
   * @param {string} auditData.entity_id - ID de la entidad
   * @param {string} auditData.action - Acción realizada (create, update, delete, reserve, release)
   * @param {Object} auditData.before_state - Estado antes del cambio
   * @param {Object} auditData.after_state - Estado después del cambio
   * @param {string} auditData.user_id - ID del usuario (opcional)
   * @param {string} auditData.ip_address - IP del usuario
   * @param {Object} auditData.metadata - Información adicional
   */
  static async log(auditData) {
    try {
      const pool = getPool();
      
      await pool.query(
        `INSERT INTO audit_log (
          entity_type, entity_id, action,
          before_state, after_state,
          user_id, ip_address, metadata,
          timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          auditData.entity_type,
          auditData.entity_id,
          auditData.action,
          JSON.stringify(auditData.before_state || {}),
          JSON.stringify(auditData.after_state || {}),
          auditData.user_id || null,
          auditData.ip_address || null,
          JSON.stringify(auditData.metadata || {})
        ]
      );
      
      console.log(`📋 Audit: ${auditData.entity_type} ${auditData.entity_id} - ${auditData.action}`);
      
    } catch (error) {
      // No propagamos el error para no romper la operación principal
      console.error('❌ Error logging audit:', error.message);
    }
  }
  
  /**
   * Registrar reserva de tickets
   */
  static async logTicketReservation(ticketTypeId, quantity, transactionId, ipAddress) {
    await this.log({
      entity_type: 'ticket_type',
      entity_id: ticketTypeId,
      action: 'reserve',
      after_state: { quantity_reserved: quantity, transaction_id: transactionId },
      ip_address: ipAddress,
      metadata: { operation: 'ticket_reservation' }
    });
  }
  
  /**
   * Registrar liberación de tickets
   */
  static async logTicketRelease(ticketTypeId, quantity, transactionId, reason) {
    await this.log({
      entity_type: 'ticket_type',
      entity_id: ticketTypeId,
      action: 'release',
      after_state: { quantity_released: quantity, transaction_id: transactionId },
      metadata: { reason, operation: 'ticket_release' }
    });
  }
  
  /**
   * Registrar cambio de estado de transacción
   */
  static async logTransactionStatusChange(transactionId, fromStatus, toStatus, metadata = {}) {
    await this.log({
      entity_type: 'transaction',
      entity_id: transactionId,
      action: 'status_change',
      before_state: { status: fromStatus },
      after_state: { status: toStatus },
      metadata: { ...metadata, operation: 'status_change' }
    });
  }
  
  /**
   * Registrar error crítico
   */
  static async logCriticalError(entityType, entityId, error, context = {}) {
    await this.log({
      entity_type: entityType,
      entity_id: entityId,
      action: 'error',
      after_state: {
        error_message: error.message,
        error_stack: error.stack
      },
      metadata: { ...context, severity: 'critical', operation: 'error' }
    });
  }
  
  /**
   * Obtener log de auditoría para una entidad
   */
  static async getEntityAudit(entityType, entityId, limit = 50) {
    const pool = getPool();
    
    const [rows] = await pool.query(
      `SELECT * FROM audit_log 
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      [entityType, entityId, limit]
    );
    
    return rows.map(row => ({
      ...row,
      before_state: JSON.parse(row.before_state || '{}'),
      after_state: JSON.parse(row.after_state || '{}'),
      metadata: JSON.parse(row.metadata || '{}')
    }));
  }
}
