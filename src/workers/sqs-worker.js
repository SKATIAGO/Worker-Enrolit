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
    try {
      const transaction = await TransactionModel.create(data);
      await logInfo('transaction', 'Transacción creada vía SQS', transaction.id, { 
        ticket_type_id: data.ticket_type_id,
        quantity: data.quantity 
      });
      return transaction;
    } catch (error) {
      await logError('transaction', 'Error al crear transacción vía SQS', data.id, { 
        error: error.message,
        ticket_type_id: data.ticket_type_id,
        quantity: data.quantity
      });
      
      throw error;
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
}

// Exportar instancia única
export const sqsWorker = new SQSWorker();
