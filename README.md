# qhiro-backend

Backend operativo de Qhiro Symbiotic. Su responsabilidad es mantener vivo el sistema aunque el frontend esté cerrado: autentica usuarios, guarda datos en Firebase, escucha MQTT, procesa telemetría, llama al servicio de IA y publica comandos hacia dispositivos.

## Qué Hace

- Expone la API HTTP que consume el frontend.
- Valida autenticación con Firebase Auth.
- Guarda usuarios, parcelas, dispositivos, vuelos, alertas y reportes en Firestore.
- Sube reportes PDF a Firebase Storage.
- Se conecta a Mosquitto por MQTT.
- Escucha telemetría de drones, sensores y nidos.
- Valida que cada dispositivo pertenezca al usuario correcto.
- Llama a `qhiro-backend-ia` para análisis agrícola.
- Ejecuta el motor de decisiones y publica comandos MQTT.
- Registra telemetría procesada y acciones físicas con estado `pending`, `completed` o `failed`.
- Permite al admin diagnosticar MQTT y publicar payloads de prueba.

## Por Qué Existe

El frontend es solo una interfaz. El backend es el orquestador real del sistema. En producción debe estar corriendo siempre porque los drones y sensores envían información por MQTT aunque ningún usuario tenga la web abierta.

## Conexiones

```text
Frontend React -> HTTP -> qhiro-backend
qhiro-backend -> Firebase Auth / Firestore / Storage / FCM
qhiro-backend -> MQTT broker Mosquitto
qhiro-backend -> HTTP -> qhiro-backend-ia
Drone/Sensor/Nido -> MQTT -> Mosquitto -> qhiro-backend
```

## Variables de Entorno

```env
PORT=3001
CORS_ORIGIN=http://localhost:5173

FIREBASE_PROJECT_ID=qhiro-symbiotic
FIREBASE_WEB_API_KEY=
FIREBASE_SERVICE_ACCOUNT_PATH=./priv/qhiro-symbiotic-firebase-adminsdk-fbsvc-34e30ef7b6.json
FIREBASE_STORAGE_BUCKET=qhiro-symbiotic.firebasestorage.app
FIREBASE_ADMIN_EMAIL=
FIREBASE_ADMIN_PASSWORD=
FIREBASE_ADMIN_DISPLAY_NAME=Qhiro Symbiotic Admin

MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_CLIENT_ID=qhiro-backend-local

AI_BACKEND_URL=http://localhost:8000
```

`CORS_ORIGIN` solo aplica al navegador. Los drones por MQTT no usan CORS.

`FIREBASE_STORAGE_BUCKET` debe coincidir con el bucket real de Firebase Storage. En proyectos nuevos suele ser `PROJECT_ID.firebasestorage.app`; en proyectos antiguos puede ser `PROJECT_ID.appspot.com`.

## Ejecución Local

```bash
npm install
npm run dev
```

Verificación:

```bash
curl http://localhost:3001/api/health
```

## Contrato MQTT

La telemetría debe publicarse en topics por usuario y dispositivo:

```text
qhiro/users/{userId}/devices/{deviceId}/{deviceType}/telemetry
```

`deviceType` puede ser:

- `drone`
- `sensor`
- `nest`

El backend valida:

- Que el dispositivo exista en Firestore.
- Que pertenezca al `userId` del topic.
- Que el tipo coincida con `deviceType`.
- Que `flightId` y `parcelId` pertenezcan al usuario cuando se completa un vuelo.

Comandos hacia dispositivos:

```text
qhiro/users/{userId}/devices/{deviceId}/command
```

Cuando el backend ordena una acción física, por ejemplo una inyección, el comando incluye `actionId`:

```json
{
  "actionId": "<actionId>",
  "action": "inject",
  "parcelId": "<parcelId>",
  "zoneId": "<zoneId>",
  "npkFormula": { "nitrogen": 42, "phosphorus": 31, "potassium": 40 },
  "timestamp": "2026-07-12T20:00:00.000Z"
}
```

El sensor o centinela debe confirmar el resultado en:

```text
qhiro/users/{userId}/devices/{deviceId}/actions/{actionId}/ack
```

Payload de confirmación:

```json
{
  "status": "completed",
  "finishedAt": "2026-07-12T20:00:10.000Z",
  "details": "Injection completed"
}
```

Si falla:

```json
{
  "status": "failed",
  "finishedAt": "2026-07-12T20:00:10.000Z",
  "error": "Valve pressure too low"
}
```

El backend calcula `durationMs` desde que emitió el comando hasta que recibió el ACK. El frontend solo consulta y muestra estos registros.

Para pruebas sin hardware, el panel admin puede publicar un ACK de centinela. Esa prueba sigue pasando por MQTT: el frontend no cierra el log directamente.

El contrato completo para firmware de Centinela está en `../docs/sentinel-mqtt-contract.md`.

## Payloads Principales

Estado básico:

```json
{
  "status": "idle",
  "batteryLevel": 85,
  "timestamp": "2026-07-12T20:00:00.000Z"
}
```

Escaneo numérico:

```json
{
  "parcelId": "<parcelId>",
  "flightId": "<flightId>",
  "status": "completed",
  "ndvi": 0.42,
  "soilMoisture": 34,
  "nitrogen": 25,
  "phosphorus": 20,
  "potassium": 32,
  "coordinates": [{ "lat": -0.1807, "lng": -78.4678 }],
  "timestamp": "2026-07-12T20:00:00.000Z"
}
```

Escaneo con imagen:

```json
{
  "parcelId": "<parcelId>",
  "flightId": "<flightId>",
  "status": "completed",
  "ndvi": 0.55,
  "soilMoisture": 40,
  "nitrogen": 35,
  "phosphorus": 28,
  "potassium": 36,
  "imageUrl": "https://example.com/crop-image.jpg",
  "coordinates": [{ "lat": -0.1807, "lng": -78.4678 }],
  "timestamp": "2026-07-12T20:00:00.000Z"
}
```

También se acepta `imageBase64` sin prefijo `data:image/...`.

## Panel Admin MQTT

El frontend consume endpoints admin para:

- Ver estado del broker.
- Publicar ping diagnóstico.
- Seleccionar cliente por nombre y correo.
- Seleccionar dispositivo por nombre, tipo e ID.
- Publicar telemetría validada por usuario/dispositivo.
- Consultar logs reales de procesamiento y acciones.
- Simular ACK de centinela para marcar acciones como completadas o fallidas durante pruebas locales.

Esto sirve para descartar rápido si un problema está en Mosquitto, backend, credenciales, topic o payload.

## Qué Falta

- ACL de Mosquitto por dispositivo para producción.
- Firmware real que publique ACKs de recepción/ejecución de comandos.
- Reintentos e idempotencia.
- Endpoints específicos para hardware si algún dispositivo usa HTTP.
- Pruebas automatizadas de MQTT, Firebase e IA.
- Observabilidad: logs estructurados, métricas y alertas.
