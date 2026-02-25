import mysql from 'mysql2/promise';
import { dbConfig } from '../config/database.js';

let pool = null;

// Crear pool de conexiones
export const createPool = () => {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
    console.log('📦 Pool de conexiones MariaDB creado');
  }
  return pool;
};

// Obtener pool de conexiones
export const getPool = () => {
  if (!pool) {
    createPool();
  }
  return pool;
};

// Verificar conexión a la base de datos
export const checkConnection = async () => {
  try {
    const connection = await getPool().getConnection();
    await connection.ping();
    connection.release();
    return { success: true, message: 'Conexión exitosa a MariaDB' };
  } catch (error) {
    console.error('❌ Error al conectar con MariaDB:', error.message);
    return { success: false, message: error.message };
  }
};

// Ejecutar query con manejo de errores
export const executeQuery = async (sql, params = []) => {
  try {
    const [rows] = await getPool().execute(sql, params);
    return { success: true, data: rows };
  } catch (error) {
    console.error('❌ Error ejecutando query:', error.message);
    return { success: false, error: error.message };
  }
};

// Cerrar pool de conexiones (para shutdown graceful)
export const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('🔌 Pool de conexiones MariaDB cerrado');
  }
};

// Inicializar base de datos
export const initializeDatabase = async () => {
  try {
    console.log('🔄 Inicializando conexión a MariaDB...');
    const pool = createPool();
    
    // Verificar conexión
    const connection = await pool.getConnection();
    console.log('✅ Conexión a MariaDB establecida');
    
    // Verificar que la base de datos existe
    await connection.query(`SELECT 1`);
    console.log(`✅ Base de datos "${dbConfig.database}" disponible`);
    
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Error al inicializar MariaDB:', error.message);
    console.error('💡 Asegúrate de que MariaDB esté corriendo y las credenciales sean correctas');
    console.error('💡 Host:', dbConfig.host);
    console.error('💡 Database:', dbConfig.database);
    console.error('💡 User:', dbConfig.user);
    return false;
  }
};

export default {
  createPool,
  getPool,
  checkConnection,
  executeQuery,
  closePool,
  initializeDatabase,
};
