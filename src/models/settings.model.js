import { getPool } from '../services/database.js';
import { logInfo, logError } from '../utils/logger.js';

/**
 * Modelo para gestionar configuraciones del sistema
 * Soporta diferentes tipos de valores y caché en memoria
 */
export class SettingsModel {
  // Caché en memoria para evitar consultas repetitivas
  static cache = new Map();
  static cacheTimeout = 5 * 60 * 1000; // 5 minutos
  static cacheTimestamps = new Map();
  
  /**
   * Obtener un valor de configuración
   * @param {string} key - Clave de configuración
   * @param {any} defaultValue - Valor por defecto si no existe
   * @returns {Promise<any>} - Valor parseado según su tipo
   */
  static async get(key, defaultValue = null) {
    // Verificar caché
    if (this.cache.has(key)) {
      const cacheTime = this.cacheTimestamps.get(key);
      if (Date.now() - cacheTime < this.cacheTimeout) {
        return this.cache.get(key);
      }
    }
    
    const pool = getPool();
    
    try {
      const [rows] = await pool.query(
        'SELECT setting_value, value_type FROM app_settings WHERE setting_key = ?',
        [key]
      );
      
      if (!rows || rows.length === 0) {
        return defaultValue;
      }
      
      const { setting_value, value_type } = rows[0];
      const parsedValue = this.parseValue(setting_value, value_type);
      
      // Guardar en caché
      this.cache.set(key, parsedValue);
      this.cacheTimestamps.set(key, Date.now());
      
      return parsedValue;
      
    } catch (error) {
      await logError('settings', 'Error al obtener configuración', null, {
        key,
        error: error.message
      });
      return defaultValue;
    }
  }
  
  /**
   * Establecer un valor de configuración
   * @param {string} key - Clave de configuración
   * @param {any} value - Valor (se convertirá a string)
   * @param {string} valueType - Tipo: boolean, string, number, json
   * @param {string} updatedBy - Usuario que realiza el cambio
   */
  static async set(key, value, valueType = 'string', updatedBy = 'system') {
    const pool = getPool();
    
    try {
      // Convertir valor a string según su tipo
      const stringValue = this.valueToString(value, valueType);
      
      await pool.query(
        `INSERT INTO app_settings (setting_key, setting_value, value_type, updated_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           setting_value = VALUES(setting_value),
           value_type = VALUES(value_type),
           updated_by = VALUES(updated_by),
           updated_at = NOW()`,
        [key, stringValue, valueType, updatedBy]
      );
      
      // Invalidar caché
      this.cache.delete(key);
      this.cacheTimestamps.delete(key);
      
      await logInfo('settings', 'Configuración actualizada', null, {
        key,
        value: stringValue,
        updated_by: updatedBy
      });
      
      return true;
      
    } catch (error) {
      await logError('settings', 'Error al establecer configuración', null, {
        key,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Obtener múltiples configuraciones por categoría
   */
  static async getByCategory(category) {
    const pool = getPool();
    
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value, value_type, description
       FROM app_settings 
       WHERE category = ?
       ORDER BY setting_key`,
      [category]
    );
    
    const settings = {};
    for (const row of rows) {
      settings[row.setting_key] = this.parseValue(row.setting_value, row.value_type);
    }
    
    return settings;
  }
  
  /**
   * Obtener todas las configuraciones públicas
   * Útil para exponer configuraciones al frontend
   */
  static async getPublicSettings() {
    const pool = getPool();
    
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value, value_type
       FROM app_settings 
       WHERE is_public = TRUE
       ORDER BY setting_key`
    );
    
    const settings = {};
    for (const row of rows) {
      settings[row.setting_key] = this.parseValue(row.setting_value, row.value_type);
    }
    
    return settings;
  }
  
  /**
   * Listar todas las configuraciones (admin)
   */
  static async getAll() {
    const pool = getPool();
    
    const [rows] = await pool.query(
      `SELECT * FROM app_settings ORDER BY category, setting_key`
    );
    
    return rows.map(row => ({
      ...row,
      parsed_value: this.parseValue(row.setting_value, row.value_type)
    }));
  }
  
  /**
   * Parsear valor según su tipo
   */
  static parseValue(value, type) {
    switch (type) {
      case 'boolean':
        return value === 'true' || value === '1' || value === 1;
      
      case 'number':
        return Number(value);
      
      case 'json':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      
      case 'string':
      default:
        return value;
    }
  }
  
  /**
   * Convertir valor a string para almacenamiento
   */
  static valueToString(value, type) {
    switch (type) {
      case 'boolean':
        return value ? 'true' : 'false';
      
      case 'number':
        return String(value);
      
      case 'json':
        return JSON.stringify(value);
      
      case 'string':
      default:
        return String(value);
    }
  }
  
  /**
   * Limpiar caché completo
   */
  static clearCache() {
    this.cache.clear();
    this.cacheTimestamps.clear();
  }
  
  /**
   * Métodos de conveniencia para configuraciones comunes
   */
  
  static async isAutoCompleteEnabled() {
    return await this.get('auto_complete_on_revision', false);
  }
  
  static async isBrevoEnabled() {
    return await this.get('brevo_enabled', true);
  }
  
  static async shouldSendPaymentConfirmation() {
    return await this.get('send_payment_confirmation_email', true);
  }
  
  static async isMaintenanceMode() {
    return await this.get('maintenance_mode', false);
  }
}
