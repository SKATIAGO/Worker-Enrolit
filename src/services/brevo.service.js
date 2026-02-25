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
      const response = await this.client.post('/smtp/email', {
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
      });
      
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
   * Generar HTML de confirmación de pago con números de corredor
   */
  generatePaymentConfirmationHTML(data) {
    const {
      race_title,
      race_date,
      race_location,
      race_image_url,
      kit_pickup_info,
      exoneration_url,
      participants // Array de participantes con bib_number
    } = data;
    
    // Generar filas de participantes
    const participantsHTML = participants.map(p => `
      <div class="info-box" style="margin: 20px 0; padding: 15px; background-color: #f8f9fa; border-radius: 5px;">
        <p class="runner-number" style="font-size: 26px; color: #ce0101; font-weight: bold; text-align: center; margin: 10px 0;">
          ${p.bib_number}
        </p>
        <p style="margin: 5px 0; text-align: center;"><strong>Corredor:</strong> ${p.first_name} ${p.last_name}</p>
        <p style="margin: 5px 0; text-align: center;"><strong>Email:</strong> ${p.email}</p>
        ${p.phone ? `<p style="margin: 5px 0; text-align: center;"><strong>Teléfono:</strong> ${p.phone}</p>` : ''}
        ${p.tshirt_size ? `<p style="margin: 5px 0; text-align: center;"><strong>Talla:</strong> ${p.tshirt_size}</p>` : ''}
      </div>
    `).join('');
    
    // Formatear fecha 
    const raceDate = new Date(race_date);
    const raceDateFormatted = raceDate.toLocaleDateString('es-MX', { 
      day: 'numeric', 
      month: 'long', 
      year: 'numeric' 
    });
    
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
    <meta name="format-detection" content="telephone=no"/>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>Confirmación de Inscripción - Enrolit</title>
    <style type="text/css">
        body {
            width: 100% !important;
            -webkit-text-size-adjust: 100%;
            -ms-text-size-adjust: 100%;
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
            background-color: #ffffff;
        }
        table {
            border-collapse: collapse;
            mso-table-lspace: 0pt;
            mso-table-rspace: 0pt;
        }
        img {
            outline: none;
            text-decoration: none;
            -ms-interpolation-mode: bicubic;
            max-width: 100%;
            height: auto;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
        }
        .header {
            padding: 20px;
            text-align: center;
        }
        .content {
            padding: 20px;
        }
        .footer {
            padding: 20px;
            text-align: center;
            background-color: #eff2f7;
        }
        h1 {
            color: #1F2D3D;
            font-size: 22px;
            margin-bottom: 20px;
            font-weight: bold;
        }
        p {
            font-size: 16px;
            line-height: 1.5;
            margin-bottom: 15px;
            color: #3b3f44;
        }
        .runner-number {
            font-size: 26px;
            color: #ce0101;
            font-weight: bold;
            margin: 20px 0;
        }
        .info-box {
            margin: 20px 0;
            padding: 15px;
            background-color: #f8f9fa;
            border-radius: 5px;
        }
        .divider {
            border: none;
            border-top: 3px solid #aaaaaa;
            margin: 30px 0;
        }
        .btn-container {
            padding: 20px 0;
            text-align: center;
        }
        .button {
            background-color: #ce0101;
            border-radius: 4px;
            color: #ffffff !important;
            display: inline-block;
            font-size: 16px;
            font-weight: bold;
            line-height: 50px;
            text-align: center;
            text-decoration: none;
            width: 250px;
            -webkit-text-size-adjust: none;
        }
        @media screen and (max-width: 600px) {
            .container {
                width: 100% !important;
                max-width: 100% !important;
            }
            h1 {
                font-size: 18px !important;
            }
            p {
                font-size: 14px !important;
            }
        }
    </style>
</head>
<body>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff;">
        <tr>
            <td align="center">
                <table class="container" width="600" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                        <td class="header">
                            ${race_image_url ? `<img src="${race_image_url}" alt="Logo del evento" style="max-width: 100%; height: auto; margin-bottom: 20px;"/>` : ''}
                        </td>
                    </tr>
                    
                    <tr>
                        <td class="content">
                            <h1 style="text-align: center;">CONFIRMACIÓN DE REGISTRO<br>${race_title.toUpperCase()}</h1>
                            
                            ${kit_pickup_info ? `
                            <p style="font-weight: bold;">Esta es tu confirmación para el evento. La entrega de números será:</p>
                            <p style="text-align: center;">
                                ${kit_pickup_info}
                            </p>
                            ` : ''}
                            
                            <hr class="divider"/>
                            
                            <h2 style="font-size: 18px; text-align: center; color: #1F2D3D; margin: 20px 0;">
                                Números de Corredor Asignados
                            </h2>
                            
                            ${participantsHTML}
                            
                            <hr class="divider"/>
                            
                            ${exoneration_url ? `
                            <h2 style="font-size: 15px; text-align: center;">"Para recoger tu kit, es indispensable presentar tu exoneración firmada, la cual puedes descargar en el siguiente enlace."</h2>
                            <div class="btn-container">
                                <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                    <tr>
                                        <td align="center">
                                            <a href="${exoneration_url}" target="_blank" class="button">DESCARGAR EXONERACIÓN</a>
                                        </td>
                                    </tr>
                                </table>
                            </div>
                            <hr class="divider"/>
                            ` : ''}
                            
                            <div style="margin: 30px 0;">
                                ${race_location ? `
                                <h2 style="color: #000; font-size: 16px; margin: 15px 0;">Ubicación</h2>
                                <p style="font-size: 16px; margin: 10px 0;">${race_location}</p>
                                ` : ''}
                                
                                <h2 style="color: #000; font-size: 19px; font-weight: bold; margin: 15px 0;">
                                    ${raceDateFormatted}
                                </h2>
                            </div>
                            
                            <div class="info-box">
                                <p style="margin: 10px 0;">
                                    <strong>Nota:</strong> Recuerda que para la entrega de kits 
                                    <strong>NO necesitas imprimir</strong> esta confirmación.
                                </p>
                                <p style="margin: 10px 0; font-size: 17px;">
                                    <strong>Cuidemos el ambiente.</strong>
                                </p>
                            </div>
                        </td>
                    </tr>
                    
                    <tr>
                        <td class="footer">
                            <img src="https://enrolit.mx/file/2023/11/enrolit_logo_2.png" alt="Enrolit" style="width: 102px; height: auto; margin-bottom: 10px;"/>
                            <p style="margin: 10px 0;">
                                <a href="https://enrolit.mx" style="color: #0092ff; text-decoration: underline;">
                                    <strong>enrolit.mx</strong>
                                </a>
                            </p>
                            <p style="font-size: 14px; color: #666; margin-top: 10px;">
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
      participants
    } = data;
    
    const htmlContent = this.generatePaymentConfirmationHTML(data);
    
    return await this.sendEmail({
      to: {
        email: buyer_email,
        name: buyer_name
      },
      subject: `Confirmación de Inscripción - ${race_title}`,
      htmlContent
    });
  }
}

export const brevoService = new BrevoService();
