import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

/**
 * Servicio para interactuar con AWS SQS
 * Maneja el envío y recepción de mensajes en las colas
 */
class SQSService {
  constructor() {
    this.enabled = process.env.SQS_ENABLED === 'true';
    
    if (!this.enabled) {
      console.log('📭 SQS está deshabilitado.');
      this.client = null;
      this.queues = {};
      return;
    }

    // Configurar cliente SQS
    const region = process.env.AWS_REGION || 'eu-west-1';
    
    this.client = new SQSClient({ 
      region,
      // Usar credenciales del IAM role de ECS (automático en AWS)
    });

    // URLs de las colas
    this.queues = {
      transactions: process.env.SQS_TRANSACTIONS_QUEUE_URL,
      notifications: process.env.SQS_NOTIFICATIONS_QUEUE_URL
    };

    console.log(`✅ SQS Service configurado en región: ${region}`);
    console.log(`📬 Colas configuradas:`, {
      transactions: this.queues.transactions ? '✓' : '✗',
      notifications: this.queues.notifications ? '✓' : '✗'
    });
  }

  /**
   * Recibir mensajes de una cola
   * @param {string} queueName - Nombre de la cola
   * @param {Object} options - Opciones de recepción
   * @returns {Promise<Array>} - Array de mensajes
   */
  async receiveMessages(queueName, options = {}) {
    if (!this.enabled) {
      return [];
    }

    const queueUrl = this.queues[queueName];
    
    if (!queueUrl) {
      throw new Error(`Cola no configurada: ${queueName}`);
    }

    try {
      const params = {
        QueueUrl: queueUrl,
        MaxNumberOfMessages: options.maxMessages || parseInt(process.env.WORKER_MAX_MESSAGES || '10'),
        WaitTimeSeconds: options.waitTime || parseInt(process.env.WORKER_WAIT_TIME || '10'), // Long polling  
        VisibilityTimeout: options.visibilityTimeout || parseInt(process.env.WORKER_VISIBILITY_TIMEOUT || '300'), // 5 minutos
        MessageAttributeNames: ['All'],
        AttributeNames: ['All']
      };

      const command = new ReceiveMessageCommand(params);
      const response = await this.client.send(command);

      const messages = response.Messages || [];
      
      if (messages.length > 0) {
        console.log(`📥 Recibidos ${messages.length} mensajes de ${queueName}`);
      }

      return messages.map(msg => ({
        messageId: msg.MessageId,
        receiptHandle: msg.ReceiptHandle,
        body: JSON.parse(msg.Body),
        attributes: msg.Attributes,
        messageAttributes: msg.MessageAttributes,
        approximateReceiveCount: parseInt(msg.Attributes?.ApproximateReceiveCount || '0')
      }));

    } catch (error) {
      console.error(`❌ Error al recibir mensajes de ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Eliminar mensaje de la cola después de procesarlo
   * @param {string} queueName - Nombre de la cola
   * @param {string} receiptHandle - Receipt handle del mensaje
   */
  async deleteMessage(queueName, receiptHandle) {
    if (!this.enabled) {
      return;
    }

    const queueUrl = this.queues[queueName];
    
    if (!queueUrl) {
      throw new Error(`Cola no configurada: ${queueName}`);
    }

    try {
      const command = new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle
      });

      await this.client.send(command);
      console.log(`🗑️  Mensaje eliminado de ${queueName}`);

    } catch (error) {
      console.error(`❌ Error al eliminar mensaje de ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Obtener atributos de una cola (tamaño, mensajes en vuelo, etc.)
   * @param {string} queueName - Nombre de la cola
   * @returns {Promise<Object>} - Atributos de la cola
   */
  async getQueueAttributes(queueName) {
    if (!this.enabled) {
      return {};
    }

    const queueUrl = this.queues[queueName];
    
    if (!queueUrl) {
      throw new Error(`Cola no configurada: ${queueName}`);
    }

    try {
      const command = new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['All']
      });

      const response = await this.client.send(command);
      
      return {
        approximateNumberOfMessages: parseInt(response.Attributes?.ApproximateNumberOfMessages || '0'),
        approximateNumberOfMessagesNotVisible: parseInt(response.Attributes?.ApproximateNumberOfMessagesNotVisible || '0'),
        approximateNumberOfMessagesDelayed: parseInt(response.Attributes?.ApproximateNumberOfMessagesDelayed || '0')
      };

    } catch (error) {
      console.error(`❌ Error al obtener atributos de ${queueName}:`, error);
      throw error;
    }
  }
}

// Exportar instancia única (singleton)
export const sqsService = new SQSService();
