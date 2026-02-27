import axios from 'axios';
import { logInfo, logError } from '../utils/logger.js';
import { SettingsModel } from '../models/settings.model.js';

/**
 * Servicio para integración con Brevo (SendinBlue)
 * Maneja envío de emails transaccionales
 * Docs: https://developers.brevo.com/reference/sendtransacemail
 */
class BrevoService {
  constructor() {
    this.apiKey = process.env.BREVO_API_KEY;
    this.apiUrl = 'https://api.brevo.com/v3';
    this.fromEmail = process.env.BREVO_FROM_EMAIL || 'inscripciones@enrolit.mx';
    this.fromName = process.env.BREVO_FROM_NAME || 'Enrolit';
    this.backendUrl = process.env.BACKEND_URL || 'https://dfmx5mp0jfwlh.cloudfront.net';
    
    if (!this.apiKey) {
      console.warn('⚠️  BREVO_API_KEY no configurada. Emails NO se enviarán.');
      this.enabled = false;
      return;
    }
    
    this.enabled = true;
    
    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000 // 30 segundos
    });
    
    console.log(`✅ Brevo Service configurado (${this.fromEmail})`);
  }
  
  /**
   * Enviar email transaccional con HTML personalizado
   */
  async sendEmail({ to, subject, htmlContent, replyTo = null }) {
    if (!this.enabled) {
      console.log('📭 Brevo deshabilitado, email no enviado:', to.email);
      return { success: false, reason: 'BREVO_DISABLED' };
    }
    
    // Verificar configuración global
    const brevoEnabled = await SettingsModel.isBrevoEnabled();
    if (!brevoEnabled) {
      console.log('📭 Brevo deshabilitado por configuración, email no enviado');
      return { success: false, reason: 'DISABLED_BY_SETTINGS' };
    }
    
    try {
      const payload = {
        sender: {
          name: this.fromName,
          email: this.fromEmail
        },
        to: [
          {
            email: to.email,
            name: to.name || to.email
          }
        ],
        subject,
        htmlContent,
        replyTo: replyTo ? { email: replyTo } : undefined
      };

      const response = await this.client.post('/smtp/email', payload);
      
      await logInfo('brevo', 'Email enviado exitosamente', null, {
        to: to.email,
        subject,
        message_id: response.data.messageId
      });
      
      return {
        success: true,
        messageId: response.data.messageId
      };
      
    } catch (error) {
      await logError('brevo', 'Error al enviar email', null, {
        to: to.email,
        subject,
        error: error.message,
        response: error.response?.data
      });
      
      throw new Error(`Error Brevo: ${error.response?.data?.message || error.message}`);
    }
  }
  
  /**
   * Genera URL del endpoint propio /api/qr para embeber en emails
   * El email client carga la imagen como cualquier <img src="https://...">
   * Sin dependencias externas — QR generado por nuestro propio backend
   */
  _generateQRUrl(text) {
    const encoded = encodeURIComponent(text);
    return `${this.backendUrl}/api/qr?data=${encoded}`;
  }

  /**
   * Generar HTML de confirmación de pago con diseño moderno Enrolit + QR
   */
  generatePaymentConfirmationHTML(data) {
    const {
      transaction_id,
      race_title,
      race_date,
      race_location,
      race_image_url,
      kit_pickup_info,
      exoneration_url,
      participants
    } = data;

    const raceDate = new Date(race_date);
    const raceDateFormatted = raceDate.toLocaleDateString('es-MX', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    // Generar bloque HTML por cada participante con su QR único
    const participantsHTML = participants.map((p, idx) => {
      const qrValue = `ENROLIT|TX:${transaction_id}|BIB:${p.bib_number}|DNI:${p.dni || ''}`;
      const qrUrl = this._generateQRUrl(qrValue);

      return `
      <!-- Participante ${idx + 1} -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
        <tr>
          <td style="background: #f8faff; border: 2px solid #e8f0fe; border-radius: 16px; padding: 0; overflow: hidden;">

            <!-- Número de corredor header -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background: linear-gradient(135deg, #0056D6 0%, #007BFF 100%); padding: 18px 24px; border-radius: 14px 14px 0 0; text-align: center;">
                  <p style="margin: 0; font-family: Arial, sans-serif; font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.75); letter-spacing: 2px; text-transform: uppercase;">NÚMERO DE CORREDOR</p>
                  <p style="margin: 4px 0 0; font-family: Arial, sans-serif; font-size: 52px; font-weight: 900; color: #ffffff; letter-spacing: -2px; line-height: 1;">${p.bib_number}</p>
                </td>
              </tr>
            </table>

            <!-- Datos del corredor -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding: 20px 24px 8px;">
                  <p style="margin: 0 0 4px; font-family: Arial, sans-serif; font-size: 18px; font-weight: 700; color: #1a1a1a; text-align: center;">${p.first_name} ${p.last_name}</p>
                  <p style="margin: 0; font-family: Arial, sans-serif; font-size: 14px; color: #666; text-align: center;">${p.email}</p>
                </td>
              </tr>
              ${p.tshirt_size ? `
              <tr>
                <td style="padding: 8px 24px 0; text-align: center;">
                  <span style="display: inline-block; background: #e8f0fe; color: #0056D6; padding: 4px 14px; border-radius: 20px; font-family: Arial, sans-serif; font-size: 13px; font-weight: 600;">Talla: ${p.tshirt_size}</span>
                </td>
              </tr>` : ''}
            </table>

            <!-- QR Code -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding: 20px 24px; text-align: center;">
                  <p style="margin: 0 0 12px; font-family: Arial, sans-serif; font-size: 12px; font-weight: 700; color: #666; letter-spacing: 1.5px; text-transform: uppercase;">Presenta este QR en la entrega de kit</p>
                  <div style="display: inline-block; background: white; padding: 12px; border-radius: 12px; border: 2px solid #e8f0fe; box-shadow: 0 4px 12px rgba(0,86,214,0.12);">
                    <img src="${qrUrl}" alt="QR Kit ${p.bib_number}" width="180" height="180" style="display: block; border: 0;"/>
                  </div>
                  <p style="margin: 10px 0 0; font-family: Arial, sans-serif; font-size: 11px; color: #999;">ID: ${transaction_id.split('-')[0].toUpperCase()}...${p.bib_number}</p>
                </td>
              </tr>
            </table>

          </td>
        </tr>
      </table>`;
    });

    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Confirmación de Inscripción - Enrolit</title>
</head>
<body style="margin:0; padding:0; background-color:#f0f4f8; font-family: Arial, Helvetica, sans-serif; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0f4f8; padding: 32px 16px;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%;">

        <!-- HEADER MARCA -->
        <tr>
          <td style="background: linear-gradient(135deg, #003fa3 0%, #0056D6 50%, #007BFF 100%); border-radius: 20px 20px 0 0; padding: 32px 40px; text-align: center;">
            <img src="https://enrolit.mx/file/2023/11/enrolit_logo_2.png" alt="Enrolit" width="120" style="display:inline-block; filter: brightness(0) invert(1); margin-bottom: 16px;"/>
            <!-- Badge éxito -->
            <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
              <tr>
                <td style="background: rgba(16,185,129,0.2); border: 1.5px solid rgba(16,185,129,0.5); border-radius: 30px; padding: 6px 18px;">
                  <p style="margin:0; font-size:13px; font-weight:700; color:#6ee7b7; letter-spacing:1px; text-transform:uppercase;">✓ Inscripción Confirmada</p>
                </td>
              </tr>
            </table>
            <h1 style="margin: 16px 0 4px; font-size: 26px; font-weight: 900; color: #ffffff; line-height: 1.2; letter-spacing: -0.5px;">${race_title}</h1>
            <p style="margin: 0; font-size: 15px; color: rgba(255,255,255,0.8);">${raceDateFormatted}</p>
            ${race_location ? `<p style="margin: 6px 0 0; font-size: 14px; color: rgba(255,255,255,0.65);">📍 ${race_location}</p>` : ''}
          </td>
        </tr>

        <!-- CUERPO PRINCIPAL -->
        <tr>
          <td style="background: #ffffff; padding: 32px 36px;">

            <!-- Mensaje bienvenida -->
            <p style="margin: 0 0 24px; font-size: 16px; color: #444; line-height: 1.6; text-align: center;">
              Tu inscripción ha sido procesada correctamente. A continuación encontrarás<br/>
              <strong style="color: #0056D6;">tu número de corredor y el código QR</strong> para la recogida de tu kit.
            </p>

            ${kit_pickup_info ? `
            <!-- Info entrega kit -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 24px;">
              <tr>
                <td style="background: #fff8e1; border-left: 4px solid #F59E0B; border-radius: 0 8px 8px 0; padding: 14px 18px;">
                  <p style="margin: 0 0 4px; font-size: 12px; font-weight: 700; color: #92620a; text-transform: uppercase; letter-spacing: 1px;">📦 Entrega de Kit</p>
                  <p style="margin: 0; font-size: 14px; color: #78450a; line-height: 1.5;">${kit_pickup_info}</p>
                </td>
              </tr>
            </table>` : ''}

            <!-- Participantes con QR -->
            ${participantsHTML.join('')}

            ${exoneration_url ? `
            <!-- Exoneración -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
              <tr>
                <td style="background: #fef2f2; border: 1.5px solid #fca5a5; border-radius: 12px; padding: 18px 24px; text-align: center;">
                  <p style="margin: 0 0 12px; font-size: 14px; color: #7f1d1d; line-height: 1.5;">
                    ⚠️ Para recoger tu kit es <strong>indispensable presentar tu exoneración firmada</strong>.
                  </p>
                  <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
                    <tr>
                      <td style="background: #EF4444; border-radius: 8px;">
                        <a href="${exoneration_url}" target="_blank" style="display: inline-block; padding: 12px 28px; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none; letter-spacing: 0.5px;">Descargar Exoneración →</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>` : ''}

            <!-- Nota sin imprimir -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
              <tr>
                <td style="background: #f0f9ff; border: 1.5px solid #bae6fd; border-radius: 12px; padding: 16px 20px; text-align: center;">
                  <p style="margin: 0; font-size: 14px; color: #0c4a6e; line-height: 1.5;">
                    🌿 <strong>No necesitas imprimir</strong> esta confirmación.<br/>
                    Presenta el QR desde tu móvil en la entrega de kit.
                  </p>
                </td>
              </tr>
            </table>

          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background: #1a1a2e; border-radius: 0 0 20px 20px; padding: 28px 36px; text-align: center;">
            <img src="https://enrolit.mx/file/2023/11/enrolit_logo_2.png" alt="Enrolit" width="90" style="display:inline-block; filter: brightness(0) invert(1); margin-bottom: 12px; opacity: 0.9;"/>
            <p style="margin: 0 0 6px; font-size: 13px; color: rgba(255,255,255,0.5);">
              <a href="https://enrolit.mx" style="color: #60a5fa; text-decoration: none; font-weight: 600;">enrolit.mx</a>
            </p>
            <p style="margin: 0; font-size: 12px; color: rgba(255,255,255,0.3);">
              © ${new Date().getFullYear()} Enrolit. Todos los derechos reservados.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`;
  }

  /**
   * Enviar confirmación de pago con números de corredor
   */
  async sendPaymentConfirmation(data) {
    const {
      buyer_email,
      buyer_name,
      race_title,
    } = data;

    const htmlContent = this.generatePaymentConfirmationHTML(data);

    return await this.sendEmail({
      to: { email: buyer_email, name: buyer_name },
      subject: `✅ Confirmación de Inscripción - ${race_title}`,
      htmlContent
    });
  }
}

export const brevoService = new BrevoService();
