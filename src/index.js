#!/usr/bin/env node

/**
 * ============================================
 * Worker Enrolit - Standalone Entry Point
 * ============================================
 * 
 * Proceso independiente que consume mensajes de SQS
 * y ejecuta tareas asíncronas (escritura en BD, notificaciones, etc.)
 */

import 'dotenv/config';
import { sqsWorker } from './workers/sqs-worker.js';
import { getPool, initializeDatabase } from './services/database.js';

// Configurar manejo de señales para shutdown graceful
let shutdownInProgress = false;

async function gracefulShutdown(signal) {
  if (shutdownInProgress) {
    console.log('⏳ Shutdown ya en progreso, esperando...');
    return;
  }

  shutdownInProgress = true;
  console.log(`\n🛑 Recibida señal ${signal}, iniciando shutdown graceful...`);
  
  try {
    // Detener worker SQS (terminará de procesar mensajes actuales)
    console.log('📭 Deteniendo SQS Worker...');
    await sqsWorker.stop();
    console.log('✅ SQS Worker detenido');

    // Cerrar pool de conexiones de BD
    console.log('🗄️  Cerrando conexiones de BD...');
    const pool = getPool();
    if (pool) {
      await pool.end();
      console.log('✅ Conexiones de BD cerradas');
    }

    console.log('✅ Shutdown completado exitosamente');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error durante shutdown:', error);
    process.exit(1);
  }
}

// Registrar handlers de señales
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// ============================================================================
// Inicio del Worker
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        🚀 Worker Enrolit - SQS Consumer v1.0.0           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📍 Region: ${process.env.AWS_REGION || 'eu-west-1'}`);
  console.log(`📍 SQS Enabled: ${process.env.SQS_ENABLED || 'false'}`);
  console.log('');

  try {
    // Verificar conexión a BD antes de iniciar
    console.log('🔌 Inicializando conexión a base de datos...');
    const dbInitialized = await initializeDatabase();
    
    if (!dbInitialized) {
      throw new Error('No se pudo conectar a la base de datos');
    }

    console.log('✅ Base de datos conectada y lista');
    console.log('');

    // Iniciar worker SQS
    console.log('🔄 Iniciando procesamiento de colas SQS...');
    await sqsWorker.start();

    console.log('');
    console.log('✅ Worker iniciado exitosamente');
    console.log('📊 Colas activas:', sqsWorker.getStats().queues);
    console.log('🔄 Worker procesando mensajes... (Ctrl+C para detener)');
    console.log('');

    // Imprimir estadísticas cada 60 segundos
    setInterval(() => {
      const stats = sqsWorker.getStats();
      console.log('📊 Worker Stats:', {
        uptime: process.uptime().toFixed(0) + 's',
        running: stats.running,
        processed: stats.processingCounts,
        memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + 'MB'
      });
    }, 60000);

  } catch (error) {
    console.error('❌ Error fatal al iniciar worker:', error);
    process.exit(1);
  }
}

// Iniciar aplicación
main();
