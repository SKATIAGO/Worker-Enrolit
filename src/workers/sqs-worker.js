import { sqsService } from '../services/sqs.service.js';
import { TransactionModel } from '../models/transaction.model.js';
import { logInfo, logError } from '../utils/logger.js';

/**
 * Worker que consume mensajes de SQS y ejecuta operaciones de BD
 * Diseñado para ejecutarse como proceso standalone
 */
class SQSWorker {
  constructor() {
    this.running = false;
    this.queues = ['transactions', 'notifications'];
    this.processingCounts = {
      transactions: 0,
      notifications: 0
    };
    // Map para controlar concurrencia por ticket_type_id
    // Evita locks cuando múltiples workers actualizan el mismo ticket_type
    this.ticketTypeLocks = new Map();
    this.maxConcurrentPerTicketType = 2; // Máximo 2 UPDATEs simultáneos por ticket_type
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

        // Procesar mensajes en paralelo
        if (messages.length > 0) {
          await Promise.all(
            messages.map(message => this.processMessage(queueName, message))
          );
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

    console.log(`📧 Procesando notificación ${type}:`, data);

    // TODO: Implementar envío de emails, SMS, push notifications, etc.
    // Aquí puedes agregar integraciones con:
    // - AWS SES para emails
    // - AWS SNS para SMS
    // - Firebase para push notifications
    // - Webhooks a servicios externos
    // - Actualización de CRM
    // - Analytics/tracking

    await logInfo('notification', `Notificación ${type} procesada`, null, { type, recipientEmail: data.email });
  }

  // ========================================================================
  // Operaciones de Transacciones
  // ========================================================================

  async createTransaction(data) {
    const maxRetries = 3;
    const ticketTypeId = data.ticket_type_id;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Adquirir lock antes de procesar (limita concurrencia por ticket_type)
        await this.acquireLock(ticketTypeId);
        
        try {
          const transaction = await TransactionModel.create(data);
          await logInfo('transaction', 'Transacción creada vía SQS', transaction.id, { 
            ticket_type_id: data.ticket_type_id,
            quantity: data.quantity,
            attempt 
          });
          return transaction;
        } finally {
          // Siempre liberar el lock, haya éxito o error
          this.releaseLock(ticketTypeId);
        }
        
      } catch (error) {
        // Si es lock timeout y quedan reintentos, esperar con exponential backoff
        const isLockTimeout = error.message && error.message.includes('Lock wait timeout');
        
        if (isLockTimeout && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms
          console.log(`⏳ Lock timeout en ticket_type ${ticketTypeId}, reintento ${attempt}/${maxRetries} en ${delay}ms`);
          await this.sleep(delay);
          continue; // Reintentar
        }
        
        // Si no es lock timeout o ya no hay más reintentos, loguear y lanzar error
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
