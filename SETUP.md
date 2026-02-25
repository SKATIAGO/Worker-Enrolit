# 🚀 Guía de Configuración - Worker Enrolit

Esta guía te ayudará a configurar y desplegar el Worker en un repositorio separado.

## 📋 Resumen

El Worker ahora vive en su propio repositorio (`Worker-Enrolit`) con:
- ✅ Código independiente del API
- ✅ Docker image separada  
- ✅ ECR repository dedicado
- ✅ ECS service independiente
- ✅ Pipeline CI/CD propio

## 🗂️ Estructura del Proyecto

```
Worker-Enrolit/
├── src/
│   ├── index.js                      # Entry point
│   ├── config/
│   │   └── database.js               # Config DB
│   ├── services/
│   │   ├── database.js               # Database pool
│   │   └── sqs.service.js            # SQS client
│   ├── models/
│   │   └── transaction.model.js      # Transaction operations
│   ├── utils/
│   │   └── logger.js                 # Logging utilities
│   └── workers/
│       └── sqs-worker.js             # SQS consumer logic
├── .github/
│   └── workflows/
│       └── worker-build-deploy.yaml  # CI/CD pipeline
├── Dockerfile                        # Container definition
├── package.json                      # Dependencies
├── .env.example                      # Environment template
└── README.md                         # Documentation
```

## 🔧 Paso 1: Configurar GitHub Repository

### 1.1 Crear Secrets en GitHub

Ve a `Settings → Secrets and variables → Actions` y agrega:

| Secret | Descripción | Ejemplo |
|--------|-------------|---------|
| `AWS_ROLE_ARN` | IAM role para GitHub Actions | `arn:aws:iam::123456789012:role/tickets-platform-poc-gh-worker` |
| `ECR_REGISTRY` | URL base del registry ECR | `123456789012.dkr.ecr.eu-west-1.amazonaws.com` |
| `ECR_REPOSITORY_WORKER` | Nombre del repo del worker | `tickets-platform-poc/worker` |

### 1.2 Obtener valores desde Terraform

```bash
cd Arq-Enrolit/terraform/environments/poc

# Obtener outputs
terraform output ecr_worker_repository_url
terraform output worker_service_name
terraform output github_actions_role_arns
```

## 🏗️ Paso 2: Desplegar Infraestructura

### 2.1 Aplicar cambios de Terraform

```bash
cd Arq-Enrolit/terraform/environments/poc

# Ver cambios
terraform plan

# Aplicar
terraform apply
```

Esto creará:
- ✅ ECR repository: `tickets-platform-poc/worker`
- ✅ ECS Task Definition: `tickets-platform-poc-worker`
- ✅ ECS Service: `tickets-platform-poc-worker`
- ✅ IAM roles con permisos SQS
- ✅ Security groups

### 2.2 Verificar recursos creados

```bash
# Ver repositorio ECR
aws ecr describe-repositories \
   --repository-names tickets-platform-poc/worker \
  --region eu-west-1

# Ver ECS services
aws ecs list-services \
  --cluster tickets-platform-poc-cluster \
  --region eu-west-1
```

## 🐳 Paso 3: Build y Deploy Inicial

### 3.1 Build local (opcional, para testing)

```bash
cd Worker-Enrolit

# Build
docker build -t worker-enrolit:local .

# Test local
docker run --rm \
  --env-file .env \
  worker-enrolit:local
```

### 3.2 Push manual a ECR (primera vez)

```bash
# Login a ECR
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin \
  123456789012.dkr.ecr.eu-west-1.amazonaws.com

# Tag
docker tag worker-enrolit:local \
  123456789012.dkr.ecr.eu-west-1.amazonaws.com/tickets-platform-poc/worker:latest

# Push
docker push \
  123456789012.dkr.ecr.eu-west-1.amazonaws.com/tickets-platform-poc/worker:latest
```

### 3.3 Deploy automático con GitHub Actions

```bash
cd Worker-Enrolit

git add .
git commit -m "feat: initial worker setup"
git push origin main
```

Esto disparará automáticamente el workflow que:
1. Construye la imagen Docker
2. La sube a ECR
3. Actualiza el ECS service

## ✅ Paso 4: Verificar Deployment

### 4.1 Ver estado del service

```bash
aws ecs describe-services \
  --cluster tickets-platform-poc-cluster \
  --services tickets-platform-poc-worker \
  --region eu-west-1 \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount}'
```

### 4.2 Ver logs del worker

```bash
# Ver logs en tiempo real
aws logs tail /ecs/tickets-platform-poc-worker \
  --region eu-west-1 \
  --follow

# Ver últimos 5 minutos
aws logs tail /ecs/tickets-platform-poc-worker \
  --region eu-west-1 \
  --since 5m
```

### 4.3 Verificar procesamiento

```bash
# Ver estadísticas del worker
aws logs tail /ecs/tickets-platform-poc-worker \
  --region eu-west-1 \
  --since 2m \
  --format short | grep "Stats:"
```

## 🧪 Paso 5: Testing End-to-End

### 5.1 Enviar transacción desde el API

```bash
curl -X POST http://<ALB-DNS>/api/v1/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "ticket_type_id": 1,
    "quantity": 2,
    "buyer_name": "Test Usuario",
    "buyer_email": "test@example.com"
  }'
```

Deberías recibir:
```json
{
  "success": true,
  "transaction_id": "uuid-aqui",
  "status": 202
}
```

### 5.2 Verificar procesamiento

```bash
# Ver mensaje procesado en logs
aws logs tail /ecs/tickets-platform-poc-worker \
  --region eu-west-1 \
  --since 1m | grep "Mensaje procesado"
```

### 5.3 Consultar transacción

```bash
curl http://<ALB-DNS>/api/v1/transactions/<transaction_id>
```

Debería mostrar `status: "creado"` o `"procesando"`.

## 🔄 Flujo de Trabajo

```
┌──────────────────────────────────────────────────────────────┐
│                  FLUJO COMPLETO                               │
└──────────────────────────────────────────────────────────────┘

1. git push origin main (Worker-Enrolit)
   ↓
2. GitHub Actions ejecuta workflow
   ↓
3. Build Docker image
   ↓
4. Push to ECR
   ↓
5. Update ECS Task Definition
   ↓
6. Update ECS Service (rolling update)
   ↓
7. Health checks pass
   ↓
8. Service stable ✅
```

## 🛠️ Troubleshooting

### Worker no inicia

```bash
# Ver eventos del service
aws ecs describe-services \
  --cluster tickets-platform-poc-cluster \
  --services tickets-platform-poc-worker \
  --region eu-west-1 \
  --query 'services[0].events[:5]'
```

### No se conecta a la BD

```bash
# Verificar security group
aws ec2 describe-security-groups \
  --group-ids <worker-sg-id> \
  --region eu-west-1

# Verificar variables de entorno en task definition
aws ecs describe-task-definition \
  --task-definition tickets-platform-poc-worker \
  --region eu-west-1 \
  --query 'taskDefinition.containerDefinitions[0].environment'
```

### Mensajes no se procesan

```bash
# Ver atributos de la cola
aws sqs get-queue-attributes \
  --queue-url <queue-url> \
  --attribute-names All \
  --region eu-west-1
```

## 📊 Monitoreo

### CloudWatch Metrics

```bash
# Ver métricas del service
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=tickets-platform-poc-worker \
              Name=ClusterName,Value=tickets-platform-poc-cluster \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-01T23:59:59Z \
  --period 3600 \
  --statistics Average \
  --region eu-west-1
```

### Logs Insights Queries

```sql
-- Mensajes procesados por minuto
fields @timestamp, @message
| filter @message like /Mensaje procesado/
| stats count() by bin(5m)
```

## 🔐 Seguridad

### Permisos IAM Requeridos

El worker necesita:
- `sqs:ReceiveMessage` - Leer mensajes
- `sqs:DeleteMessage` - Eliminar mensajes procesados
- `sqs:GetQueueAttributes` - Obtener stats de cola
- `rds:Connect` - Conexión a BD (si usa IAM auth)

### Secrets Management

Variables sensibles se configuran en:
1. **Terraform**: `db_password_secret_arn` (AWS Secrets Manager)
2. **ECS Task Definition**: Inyectadas como environment variables
3. **Nunca en código**: No hardcodear credenciales

## 🚀 Próximos Pasos

1. ✅ Worker desplegado y funcionando
2. ⏭️ Agregar más tipos de tareas (notificaciones, webhooks)
3. ⏭️ Implementar métricas personalizadas
4. ⏭️ Configurar alertas CloudWatch
5. ⏭️ Agregar tests automatizados

## 📚 Referencias

- [Worker README](../README.md)
- [Workflow GitHub Actions](.github/workflows/worker-build-deploy.yaml)
- [Terraform ECS Worker](../Arq-Enrolit/terraform/modules/ecs-worker/)
