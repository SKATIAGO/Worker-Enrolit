import { createClient } from 'redis';

/**
 * Servicio de caché con Redis para el Worker.
 * Usado para operaciones atómicas de stock y contadores.
 */
class CacheService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.isEnabled = process.env.REDIS_HOST ? true : false;
  }

  async connect() {
    if (!this.isEnabled) {
      console.log('⚠️  Redis deshabilitado (no hay REDIS_HOST configurado)');
      return;
    }

    try {
      const useTls = process.env.REDIS_TLS === 'true';
      const protocol = useTls ? 'rediss' : 'redis';
      const password = process.env.REDIS_PASSWORD;
      const authPart = password ? `:${password}@` : '';
      const redisUrl = `${protocol}://${authPart}${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`;
      
      console.log(`🔧 Redis config: TLS=${useTls}, host=${process.env.REDIS_HOST}, port=${process.env.REDIS_PORT}`);

      this.client = createClient({
        url: redisUrl,
        socket: {
          tls: useTls,
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              console.error('❌ Redis: Máximo de reintentos alcanzado');
              return new Error('Máximo de reintentos alcanzado');
            }
            return retries * 100;
          }
        }
      });

      this.client.on('error', (err) => {
        console.error('❌ Redis error:', err.message);
        this.isConnected = false;
      });

      this.client.on('ready', () => {
        console.log('✅ Redis conectado y listo');
        this.isConnected = true;
      });

      await this.client.connect();
    } catch (error) {
      console.error('❌ Error conectando a Redis:', error.message);
      this.isConnected = false;
      this.isEnabled = false;
    }
  }

  /**
   * Reservar stock atómicamente
   */
  async reserveStock(ticketTypeId, quantity, availableQuantity) {
    if (!this.isConnected || !this.isEnabled) {
      return { success: false, error: 'redis_unavailable' };
    }
    try {
      const key = `stock:sold:${ticketTypeId}`;
      const newSold = await this.client.incrBy(key, quantity);
      if (newSold > availableQuantity) {
        await this.client.decrBy(key, quantity);
        const remaining = availableQuantity - (newSold - quantity);
        return { success: false, newSold: null, error: 'sold_out', remaining: Math.max(0, remaining) };
      }
      return { success: true, newSold };
    } catch (error) {
      console.error(`Error en reserveStock [tt:${ticketTypeId}]:`, error.message);
      return { success: false, error: 'redis_error' };
    }
  }

  /**
   * Liberar stock atómicamente
   */
  async releaseStock(ticketTypeId, quantity) {
    if (!this.isConnected || !this.isEnabled) return false;
    try {
      await this.client.decrBy(`stock:sold:${ticketTypeId}`, quantity);
      return true;
    } catch (error) {
      console.error(`Error en releaseStock [tt:${ticketTypeId}]:`, error.message);
      return false;
    }
  }

  /**
   * Incrementar contador de participantes de una carrera
   */
  async incrParticipants(raceId, quantity = 1) {
    if (!this.isConnected || !this.isEnabled) return null;
    try {
      return await this.client.incrBy(`participants:${raceId}`, quantity);
    } catch (error) {
      console.error(`Error en incrParticipants [race:${raceId}]:`, error.message);
      return null;
    }
  }

  /**
   * Lock distribuido via Redis
   */
  async acquireLock(lockName, ttlSeconds = 30) {
    if (!this.isConnected || !this.isEnabled) return false;
    try {
      const result = await this.client.set(`lock:${lockName}`, '1', { NX: true, EX: ttlSeconds });
      return result !== null;
    } catch (error) {
      console.error(`Error en acquireLock [${lockName}]:`, error.message);
      return false;
    }
  }

  async releaseLock(lockName) {
    if (!this.isConnected || !this.isEnabled) return false;
    try {
      await this.client.del(`lock:${lockName}`);
      return true;
    } catch (error) {
      console.error(`Error en releaseLock [${lockName}]:`, error.message);
      return false;
    }
  }

  /**
   * Reservar un rango de bib numbers atómicamente.
   * @param {number} ticketTypeId
   * @param {number} count
   * @returns {{ startBib: number, endBib: number } | null}
   */
  async reserveBibRange(ticketTypeId, count) {
    if (!this.isConnected || !this.isEnabled) return null;
    try {
      const key = `bib:next:${ticketTypeId}`;
      const newVal = await this.client.incrBy(key, count);
      return { startBib: newVal - count + 1, endBib: newVal };
    } catch (error) {
      console.error(`Error en reserveBibRange [tt:${ticketTypeId}]:`, error.message);
      return null;
    }
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      try {
        await this.client.quit();
        console.log('🔌 Redis desconectado');
      } catch (error) {
        console.error('Error desconectando Redis:', error);
      }
    }
  }

  /**
   * Incrementar una key numérica
   */
  async incrBy(key, amount) {
    if (!this.isConnected || !this.isEnabled) return null;
    try {
      return await this.client.incrBy(key, amount);
    } catch (error) {
      console.error(`Error en incrBy [${key}]:`, error.message);
      return null;
    }
  }

  /**
   * Decrementar una key numérica
   */
  async decrBy(key, amount) {
    if (!this.isConnected || !this.isEnabled) return null;
    try {
      return await this.client.decrBy(key, amount);
    } catch (error) {
      console.error(`Error en decrBy [${key}]:`, error.message);
      return null;
    }
  }
}

export const cacheService = new CacheService();
