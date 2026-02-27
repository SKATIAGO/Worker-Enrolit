import { sqsService } from '../services/sqs.service.js';
import { TransactionModel } from '../models/transaction.model.js';
import { ParticipantModel } from '../models/participant.model.js';
import { SettingsModel } from '../models/settings.model.js';
import { brevoService } from '../services/brevo.service.js';
import { getPool } from '../services/database.js';
import { logInfo, logError } from '../utils/logger.js';

/**
 * Worker que consume mensajes de SQS y ejecuta operaciones de BD
 * Diseñado para ejecutarse como proceso standalone
 */
class SQSWorker {
  constructor() {
    this.running = false;
    this.queues = ['transactions', 'notifications', 'webhooks'];
    this.processingCounts = {
      transactions: 0,
      notifications: 0,
      webhooks: 0
    };
    // Map para controlar concurrencia por ticket_type_id
    // Evita locks cuando múltiples workers actualizan el mismo ticket_type
    this.ticketTypeLocks = new Map();
    this.maxConcurrentPerTicketType = 1; // SERIALIZAR operaciones por ticket_type (0 locks)
  }

  /**
   * Iniciar el worker
   */
  async start() {
    if (!sqsService.enabled) {
      console.log('📭 SQS Worker no iniciado (SQS deshabilitado)');
      return;
    }

    if (this.running) {
      console.log('⚠️  SQS Worker ya está ejecutándose');
      return;
    }

    this.running = true;
    console.log('🚀 SQS Worker iniciado - procesando colas:', this.queues.join(', '));

    // Iniciar polling de cada cola en paralelo
    this.queues.forEach(queueName => {
      this.pollQueue(queueName);
    });
  }

  /**
   * Detener el worker
   */
  async stop() {
    console.log('⏸️  Deteniendo SQS Worker...');
    this.running = false;
    
    // Esperar un poco para que terminen los mensajes en proceso
    await this.sleep(2000);
    console.log('✅ SQS Worker detenido');
  }

  /**
   * Polling continuo de una cola
   * @param {string} queueName - Nombre de la cola
   */
  async pollQueue(queueName) {
    console.log(`🔄 Iniciando polling de cola: ${queueName}`);
    
    while (this.running) {
      try {
        // Recibir mensajes (long polling)
        const messages = await sqsService.receiveMessages(queueName);

        // Procesar mensajes SECUENCIALMENTE para respetar locks por ticket_type
        // Evita que múltiples mensajes del mismo ticket_type compitan en la BD
        if (messages.length > 0) {
          for (const message of messages) {
            await this.processMessage(queueName, message);
          }
        }

      } catch (error) {
        console.error(`❌ Error en polling de ${queueName}:`, error);
        // Esperar un poco antes de reintentar si hay error
        await this.sleep(5000);
      }
    }
    
    console.log(`⏹️  Polling detenido para cola: ${queueName}`);
  }

  /**
   * Procesar un mensaje individual
   * @param {string} queueName - Nombre de la cola
   * @param {Object} message - Mensaje de SQS
   */
  async processMessage(queueName, message) {
    const startTime = Date.now();
    
    try {
      console.log(`⚙️  Procesando mensaje de ${queueName}:`, message.messageId);

      // Ejecutar la operación según el tipo de cola
      if (queueName === 'transactions') {
        await this.processTransactionMessage(message);
      } else if (queueName === 'notifications') {
        await this.processNotificationMessage(message);
      } else if (queueName === 'webhooks') {
        await this.processWebhookMessage(message);
      }

      // Eliminar mensaje exitoso de la cola
      await sqsService.deleteMessage(queueName, message.receiptHandle);
      
      this.processingCounts[queueName]++;
      const duration = Date.now() - startTime;
      console.log(`✅ Mensaje procesado en ${duration}ms - Total ${queueName}: ${this.processingCounts[queueName]}`);

    } catch (error) {
      console.error(`❌ Error procesando mensaje de ${queueName}:`, error);
      console.error('Mensaje body:', message.body);
      
      // Si el mensaje ha sido reintentado más de 2 veces, loguearlo
      if (message.approximateReceiveCount >= 2) {
        await logError('sqs-worker', `Mensaje fallido (intento ${message.approximateReceiveCount})`, null, {
          queueName,
          messageId: message.messageId,
          error: error.message,
          body: message.body
        });
      }

      // No eliminar el mensaje - SQS lo reintentará o lo moverá a DLQ
    }
  }

  /**
   * Procesar mensaje de transacciones
   * @param {Object} message - Mensaje con operación de transacción
   */
  async processTransactionMessage(message) {
    const { operation, data } = message.body;

    switch (operation) {
      case 'create':
        await this.createTransaction(data);
        break;
      
      case 'update':
        await this.updateTransaction(data);
        break;
      
      case 'markPaid':
        await this.markTransactionPaid(data);
        break;
      
      case 'markFailed':
        await this.markTransactionFailed(data);
        break;
      
      case 'expire':
        await this.expireTransaction(data);
        break;
      
      default:
        throw new Error(`Operación desconocida: ${operation}`);
    }
  }

  /**
   * Procesar mensaje de notificaciones
   * @param {Object} message - Mensaje con notificación
   */
  async processNotificationMessage(message) {
    const { type, data } = message.body;

    console.log(`📧 Procesando notificación ${type}`);

    switch(type) {
      case 'payment_confirmed':
        await this.sendPaymentConfirmationEmail(data);
        break;
      
      // Futuros tipos de notificaciones
      case 'race_reminder':
        // TODO: Email de recordatorio pre-carrera
        break;
      
      case 'results_available':
        // TODO: Email con resultados
        break;
      
      default:
        console.warn(`⚠️  Tipo de notificación desconocido: ${type}`);
    }

    await logInfo('notification', `Notificación ${type} procesada`, null, { 
      type, 
      recipient_email: data.buyer_email 
    });
  }

  /**
   * Enviar email de confirmación de pago con números de corredor
   */
  async sendPaymentConfirmationEmail(data) {
    try {
      const {
        transaction_id,
        buyer_email,
        buyer_name,
        race_id,
        participants // Ya incluye bib_number
      } = data;
      
      console.log(`📧 Enviando confirmación de pago a ${buyer_email} (${participants.length} participantes)`);
      
      // Verificar si está habilitado el envío
      const shouldSend = await SettingsModel.shouldSendPaymentConfirmation();
      if (!shouldSend) {
        console.log('📭 Envío de confirmación deshabilitado por configuración');
        return;
      }
      
      // Obtener información completa de la carrera
      const pool = getPool();
      const [races] = await pool.query(
        `SELECT 
          name as title, 
          event_date as start_date, 
          location,
          image_url,
          kit_pickup_info,
          exoneration_url
         FROM races 
         WHERE id = ?`,
        [race_id]
      );
      
      if (!races || races.length === 0) {
        throw new Error(`Carrera no encontrada: ${race_id}`);
      }
      
      const race = races[0];
      
      // Enviar email con Brevo
      await brevoService.sendPaymentConfirmation({
        transaction_id,
        buyer_email,
        buyer_name,
        race_title: race.title,
        race_date: race.start_date,
        race_location: race.location,
        race_image_url: race.image_url,
        kit_pickup_info: race.kit_pickup_info,
        exoneration_url: race.exoneration_url,
        participants
      });
      
      console.log(`✅ Email enviado exitosamente a ${buyer_email}`);
      
      // Loguear envío
      await logInfo('email', 'Email de confirmación enviado', transaction_id, {
        recipient: buyer_email,
        participant_count: participants.length,
        race_title: race.title
      });
      
    } catch (error) {
      console.error(`❌ Error al enviar email de confirmación:`, error);
      
      await logError('email', 'Error al enviar confirmación', data.transaction_id, {
        error: error.message,
        recipient: data.buyer_email
      });
      
      // Re-lanzar error para que SQS reintente
      throw error;
    }
  }

  /**
   * Procesar mensaje de webhooks de pasarelas de pago
   * @param {Object} message - Mensaje con webhook data
   */
  async processWebhookMessage(message) {
    const { operation, data } = message.body;

    if (operation === 'process_webhook') {
      await this.handlePaymentWebhook(data);
    } else {
      throw new Error(`Operación de webhook desconocida: ${operation}`);
    }
  }

  /**
   * Procesar webhook de pasarela de pago
   * @param {Object} data - Datos del webhook
   */
  async handlePaymentWebhook(data) {
    const {
      transaction_id,
      payment_gateway,
      status,
      payment_gateway_transaction_id,
      payment_method,
      gateway_response
    } = data;

    console.log(`💳 Procesando webhook de ${payment_gateway} para transacción ${transaction_id}:`, status);

    // Buscar transacción
    const transaction = await TransactionModel.findById(transaction_id);

    if (!transaction) {
      await logError('webhook', 'Transacción no encontrada en webhook', transaction_id, {
        payment_gateway,
        status
      });
      throw new Error(`Transacción no encontrada: ${transaction_id}`);
    }

    // Determinar nuevo estado basado en respuesta de pasarela
    let newStatus;
    let note;

    if (status === 'success' || status === 'approved' || status === 'completed') {
      newStatus = 'revision';
      note = `Pago aprobado por ${payment_gateway}`;
    } else if (status === 'failed' || status === 'rejected' || status === 'declined') {
      newStatus = 'erroneo';
      note = `Pago rechazado por ${payment_gateway}`;
    } else if (status === 'pending') {
      // Mantener en procesando, solo loguear
      await logInfo('webhook', 'Pago pendiente, manteniendo estado', transaction_id, {
        payment_gateway,
        status
      });
      console.log(`⏳ Pago pendiente para transacción ${transaction_id}`);
      return; // No actualizar estado
    } else {
      await logError('webhook', 'Estado de pago desconocido', transaction_id, {
        payment_gateway,
        status
      });
      throw new Error(`Estado de pago desconocido: ${status}`);
    }

    // Actualizar transacción con retry automático
    const updatedTransaction = await TransactionModel.updateStatus(
      transaction_id,
      newStatus,
      {
        payment_gateway_transaction_id,
        payment_gateway_response: gateway_response,
        payment_method,
        note
      }
    );

    await logInfo('webhook', `Webhook procesado: transacción ${transaction_id} → ${newStatus}`, transaction_id, {
      payment_gateway,
      new_status: newStatus,
      previous_status: transaction.status
    });

    console.log(`✅ Webhook procesado: ${transaction_id} → ${newStatus}`);
  }

  // ========================================================================
  // Operaciones de Transacciones
  // ========================================================================

  async createTransaction(data) {
    const maxRetries = 3;
    const ticketTypeId = data.ticket_type_id;
    
    // Adquirir lock UNA SOLA VEZ para todos los reintentos
    // Evita deadlocks entre reintentos simultáneos
    await this.acquireLock(ticketTypeId);
    
    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const transaction = await TransactionModel.create(data);
          await logInfo('transaction', 'Transacción creada vía SQS', transaction.id, { 
            ticket_type_id: data.ticket_type_id,
            quantity: data.quantity,
            attempt 
          });
          return transaction;
          
        } catch (error) {
          // Si es error de lock (timeout o deadlock) y quedan reintentos, esperar con exponential backoff
          const isLockError = error.message && (
            error.message.includes('Lock wait timeout') || 
            error.message.includes('Deadlock found')
          );
          
          if (isLockError && attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms
            const errorType = error.message.includes('Deadlock') ? 'Deadlock' : 'Lock timeout';
            console.log(`⏳ ${errorType} en ticket_type ${ticketTypeId}, reintento ${attempt}/${maxRetries} en ${delay}ms`);
            await this.sleep(delay);
            continue; // Reintentar
          }
          
          // Si no es lock error o ya no hay más reintentos, loguear y lanzar error
          await logError('transaction', 'Error al crear transacción vía SQS', data.id, { 
            error: error.message,
            ticket_type_id: data.ticket_type_id,
            quantity: data.quantity,
            attempt,
            maxRetries
          });
          
          throw error;
        }
      }
    } finally {
      // SIEMPRE liberar el lock al final, haya éxito o error
      this.releaseLock(ticketTypeId);
    }
  }

  async updateTransaction(data) {
    const { id, updateData } = data;
    const transaction = await TransactionModel.update(id, updateData);
    await logInfo('transaction', 'Transacción actualizada vía SQS', id, { updateData });
    return transaction;
  }

  async markTransactionPaid(data) {
    const { transactionId, paymentData } = data;
    const transaction = await TransactionModel.markAsPaid(transactionId, paymentData);
    await logInfo('transaction', 'Transacción marcada como pagada vía SQS', transactionId);
    return transaction;
  }

  async markTransactionFailed(data) {
    const { transactionId, reason } = data;
    const transaction = await TransactionModel.updateStatus(transactionId, 'erroneo', {
      note: reason
    });
    await logInfo('transaction', 'Transacción marcada como fallida vía SQS', transactionId, { reason });
    return transaction;
  }

  async expireTransaction(data) {
    const { transactionId } = data;
    const transaction = await TransactionModel.updateStatus(transactionId, 'expirada');
    await logInfo('transaction', 'Transacción expirada vía SQS', transactionId);
    return transaction;
  }

  // ========================================================================
  // Utilities
  // ========================================================================

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Obtener estadísticas del worker
   */
  getStats() {
    return {
      running: this.running,
      queues: this.queues,
      processingCounts: this.processingCounts
    };
  }

  // ========================================================================
  // Control de Concurrencia por ticket_type_id
  // ========================================================================

  /**
   * Adquirir lock para procesar un ticket_type específico
   * Limita la cantidad de UPDATEs simultáneos al mismo ticket_type
   * para reducir contención de locks en la base de datos
   * @param {number} ticketTypeId - ID del ticket_type
   */
  async acquireLock(ticketTypeId) {
    if (!this.ticketTypeLocks.has(ticketTypeId)) {
      this.ticketTypeLocks.set(ticketTypeId, { count: 0, queue: [] });
    }
    
    const lock = this.ticketTypeLocks.get(ticketTypeId);
    
    // Si ya hay demasiadas operaciones simultáneas en este ticket_type, esperar
    if (lock.count >= this.maxConcurrentPerTicketType) {
      await new Promise(resolve => lock.queue.push(resolve));
    }
    
    lock.count++;
  }

  /**
   * Liberar lock de un ticket_type
   * Permite que la siguiente operación en cola proceda
   * @param {number} ticketTypeId - ID del ticket_type
   */
  releaseLock(ticketTypeId) {
    const lock = this.ticketTypeLocks.get(ticketTypeId);
    if (!lock) return;
    
    lock.count--;
    
    // Si hay operaciones esperando en la cola, liberar la siguiente
    if (lock.queue.length > 0) {
      const next = lock.queue.shift();
      next();
    }
    
    // Limpiar el Map si no hay operaciones activas ni en cola
    if (lock.count === 0 && lock.queue.length === 0) {
      this.ticketTypeLocks.delete(ticketTypeId);
    }
  }
}

// Exportar instancia única
export const sqsWorker = new SQSWorker();
