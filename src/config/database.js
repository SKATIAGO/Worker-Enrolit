// Configuración de la base de datos MariaDB
export const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'enrolit',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'enrolit_db',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10'),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  // Configuraciones específicas para producción
  connectTimeout: 60000, // 60 segundos para conexión inicial
};

// Validar configuración de base de datos
export const validateDbConfig = () => {
  const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.warn(`⚠️  Variables de entorno faltantes: ${missing.join(', ')}`);
    console.warn('⚠️  Usando valores por defecto para desarrollo');
  }
  
  return missing.length === 0;
};
