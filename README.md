# 🚀 Worker Enrolit

Worker independiente para procesamiento asíncrono de tareas mediante AWS SQS.

## 📋 Descripción

Este worker consume mensajes de colas SQS y ejecuta operaciones de forma asíncrona:
- ✅ Creación y actualización de transacciones en BD
- ✅ Procesamiento de pagos
- ✅ Envío de notificaciones (emails, SMS, webhooks)
- ✅ Tareas programadas y jobs batch
- ✅ Integración con servicios externos

## 🏗️ Arquitectura

```
┌─────────────┐         ┌─────────────┐         ┌──────────────┐
│  API Backend│────────▶│   SQS Queue │────────▶│    Worker    │
│             │  enqueue │             │  poll   │              │
│  (Enrolit)  │         │  (AWS SQS)  │         │  (Este repo) │
└─────────────┘         └─────────────┘         └───────┬──────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  MariaDB (RDS)  │
                                                └─────────────────┘
```

## 🛠️ Tecnologías

- **Node.js 20+** - Runtime
- **AWS SQS** - Message Queue
- **MariaDB** - Base de datos
- **Docker** - Containerización
- **ECS Fargate** - Deployment

## 📦 Instalación

```bash
# Clonar repositorio
git clone https://github.com/SKATIAGO/Worker-Enrolit.git
cd Worker-Enrolit

# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# Ejecutar en desarrollo
npm run dev

# Ejecutar en producción
npm start
```

## 🔧 Configuración

### Variables de Entorno

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `NODE_ENV` | Entorno de ejecución | `production` |
| `WORKER_MODE` | Identificador de proceso worker | `true` |
| `AWS_REGION` | Región de AWS | `eu-west-1` |
| `SQS_ENABLED` | Habilitar SQS | `true` |
| `SQS_TRANSACTIONS_QUEUE_URL` | URL de cola de transacciones | `https://sqs.eu-west-1.amazonaws.com/...` |
| `SQS_NOTIFICATIONS_QUEUE_URL` | URL de cola de notificaciones | `https://sqs.eu-west-1.amazonaws.com/...` |
| `DB_HOST` | Host de base de datos | `rds-endpoint.amazonaws.com` |
| `DB_USER` | Usuario de BD | `dbadmin` |
| `DB_PASSWORD` | Contraseña de BD | `****` |
| `DB_NAME` | Nombre de BD | `appdb` |
| `DB_PORT` | Puerto de BD | `3306` |

### Configuración de Worker

```bash
# Mensajes por batch
WORKER_MAX_MESSAGES=10

# Tiempo de espera long polling (segundos)
WORKER_WAIT_TIME=10

# Timeout de visibilidad (segundos)
WORKER_VISIBILITY_TIMEOUT=300
```

## 📊 Operaciones Soportadas

### Cola: `transactions`

| Operación | Descripción | Payload |
|-----------|-------------|---------|
| `create` | Crear transacción | `{ ticket_type_id, quantity, buyer_*, ... }` |
| `update` | Actualizar datos | `{ id, updateData: {...} }` |
| `markPaid` | Marcar como pagada | `{ transactionId, paymentData: {...} }` |
| `markFailed` | Marcar como fallida | `{ transactionId, reason }` |
| `expire` | Expirar transacción | `{ transactionId }` |

### Cola: `notifications`

| Tipo | Descripción | Payload |
|------|-------------|---------|
| `email` | Enviar email | `{ email, subject, body, ... }` |
| `sms` | Enviar SMS | `{ phone, message }` |
| `webhook` | Llamar webhook | `{ url, method, body }` |

## 🐳 Docker

```bash
# Build
docker build -t worker-enrolit:latest .

# Run
docker run -d \
  --name worker-enrolit \
  --env-file .env \
  worker-enrolit:latest
```

## 🚀 Deployment (ECS)

El worker se despliega automáticamente mediante GitHub Actions al hacer push a `main`:

1. **Build** - Construye imagen Docker
2. **Push to ECR** - Sube a Amazon ECR
3. **Update ECS** - Actualiza task definition y service
4. **Validate** - Espera estabilización

Ver [.github/workflows/worker-build-deploy.yaml](.github/workflows/worker-build-deploy.yaml)

## 📈 Monitoreo

### Logs (CloudWatch)

```bash
aws logs tail /ecs/tickets-platform-poc-worker --region eu-west-1 --follow
```

### Métricas

El worker imprime estadísticas cada 60 segundos:
- Uptime
- Mensajes procesados por cola
- Uso de memoria

### Health Check

El worker usa un health check basado en proceso:
```bash
pgrep -f "node src/index.js"
```

## 🔒 Permisos IAM

El worker necesita los siguientes permisos:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": [
        "arn:aws:sqs:*:*:tickets-platform-*-transactions",
        "arn:aws:sqs:*:*:tickets-platform-*-notifications"
      ]
    }
  ]
}
```

## 🛡️ Error Handling

- **Reintentos automáticos**: SQS reintenta hasta 3 veces
- **Dead Letter Queue**: Mensajes fallidos van a DLQ
- **Graceful Shutdown**: SIGTERM manejado correctamente
- **Optimistic Locking**: Previene condiciones de carrera

## 🧪 Testing

```bash
# TODO: Implementar tests
npm test
```

## 📚 Agregar Nuevas Tareas

1. **Agregar nueva cola en SQS** (Terraform)
2. **Agregar URL a `.env`**
3. **Agregar cola al array** en `src/workers/sqs-worker.js`:
   ```javascript
   this.queues = ['transactions', 'notifications', 'nueva-cola'];
   ```
4. **Implementar handler**:
   ```javascript
   async processNuevaColaMessage(message) {
     const { operation, data } = message.body;
     // Tu lógica aquí
   }
   ```

## 🤝 Contribuir

1. Fork el repositorio
2. Crear feature branch (`git checkout -b feature/nueva-funcionalidad`)
3. Commit cambios (`git commit -m 'feat: agregar nueva funcionalidad'`)
4. Push al branch (`git push origin feature/nueva-funcionalidad`)
5. Abrir Pull Request

## 📄 Licencia

ISC © Enrolit Team

## 🔗 Enlaces

- [Repositorio Backend (API)](https://github.com/SKATIAGO/Back-Enrolit)
- [Documentación AWS SQS](https://docs.aws.amazon.com/sqs/)
- [Documentación ECS](https://docs.aws.amazon.com/ecs/)
