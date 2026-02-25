import { getPool } from '../services/database.js';

/**
 * Utilidades para logging en base de datos
 */

/**
 * Registrar log en base de datos
 */
async function log(level, category, message, referenceId = null, metadata = null) {
  try {
    const pool = getPool();
    
    if (!pool) {
      console.warn('⚠️  Pool no disponible, log no guardado en BD:', { level, category, message });
      return;
    }
    
    await pool.query(
      'INSERT INTO logs (level, category, message, reference_id, metadata) VALUES (?, ?, ?, ?, ?)',
      [level, category, message, referenceId, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (error) {
    // No lanzar error si falla el logging para no interrumpir el flujo
    console.error('Error al guardar log en BD:', error.message);
  }
}

/**
 * Log de debug
 */
export async function logDebug(category, message, referenceId = null, metadata = null) {
  console.log(`[DEBUG] [${category}]`, message, metadata || '');
  await log('debug', category, message, referenceId, metadata);
}

/**
 * Log de información
 */
export async function logInfo(category, message, referenceId = null, metadata = null) {
  console.log(`[INFO] [${category}]`, message, metadata || '');
  await log('info', category, message, referenceId, metadata);
}

/**
 * Log de advertencia
 */
export async function logWarning(category, message, referenceId = null, metadata = null) {
  console.warn(`[WARNING] [${category}]`, message, metadata || '');
  await log('warning', category, message, referenceId, metadata);
}

/**
 * Log de error
 */
export async function logError(category, message, referenceId = null, metadata = null) {
  console.error(`[ERROR] [${category}]`, message, metadata || '');
  await log('error', category, message, referenceId, metadata);
}

/**
 * Log crítico
 */
export async function logCritical(category, message, referenceId = null, metadata = null) {
  console.error(`[CRITICAL] [${category}]`, message, metadata || '');
  await log('critical', category, message, referenceId, metadata);
}
