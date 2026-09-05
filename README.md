# MayBach RP — Bot de Tickets

Bot privado de soporte para Discord, construido con Discord.js 14.

## Funciones

- Panel dorado de MayBach RP con menú desplegable.
- Modal para solicitar asunto y explicación antes de crear el ticket.
- Canal privado por ticket y permisos separados por categoría.
- Impide que una persona abra dos tickets simultáneos.
- Botones para reclamar, cerrar y cancelar el cierre.
- Transcripción `.txt` enviada al canal de registros antes de borrar el ticket.
- Comandos para añadir, retirar o renombrar miembros dentro de un ticket.
- No necesita base de datos; conserva la información en el tema del canal.

## Instalación

1. Instala Node.js 20 LTS o una versión superior estable.
2. Copia `.env.example` como `.env` y pega el token y el ID del servidor.
3. Copia `config.example.json` como `config.json` y completa todos los IDs.
4. Abre una terminal dentro de esta carpeta y ejecuta:

```bash
npm install
npm start
```

5. En Discord ejecuta `/ticket-panel` dentro del canal configurado para publicar el panel.

## Permisos e intents del bot

En Discord Developer Portal activa **Server Members Intent**. Invita el bot con los scopes `bot` y `applications.commands` y concédele:

- Ver canales
- Administrar canales
- Enviar mensajes
- Insertar enlaces
- Adjuntar archivos
- Leer historial de mensajes
- Usar comandos de aplicaciones

## Configuración de roles

`staffRoleIds` contiene los roles que podrán ver todos los tickets. Dentro de cada categoría, `roleIds` permite agregar departamentos concretos. Por ejemplo, en `reports` puedes colocar solamente el rol de moderación.

## Seguridad

Nunca compartas el archivo `.env`, nunca publiques el token y nunca lo pegues en una captura. Si el token se filtra, restablécelo inmediatamente desde Discord Developer Portal.
