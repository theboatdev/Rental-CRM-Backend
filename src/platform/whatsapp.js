/**
 * Sends messages through the WhatsApp Cloud API (Meta's Graph API), with a
 * tenant's own phone number ID and access token. Tests pass a fake with the
 * same `send`.
 *
 * Meta only delivers free-form text within 24 hours of the recipient's last
 * message to the business. Outside that window a business can only send an
 * approved template, so scheduled digests use one when the tenant's
 * connection names it (see digests.js).
 */

const TEXT_LIMIT = 4096;

function createWhatsAppGateway({ graphVersion = 'v25.0', fetch = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  return {
    /**
     * Sends `text`, or `template` ({ name, language, parameters: [string] },
     * the body's variables in order) to `to`, an E.164 number. Returns Meta's
     * message id; throws with Meta's message when it refuses.
     */
    async send({ phoneNumberId, accessToken, to, text, template }) {
      const message = template
        ? {
            type: 'template',
            template: {
              name: template.name,
              language: { code: template.language },
              components: [{ type: 'body', parameters: template.parameters.map((value) => ({ type: 'text', text: value })) }]
            }
          }
        : { type: 'text', text: { body: text.slice(0, TEXT_LIMIT), preview_url: false } };
      let res;
      try {
        res = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), ...message }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        throw new Error(`Couldn't reach WhatsApp: ${error.message}`);
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const error = data?.error;
        throw new Error(error?.message ? `${error.error_data?.details || error.message}${error.code ? ` (code ${error.code})` : ''}` : `WhatsApp returned ${res.status}`);
      }
      return { messageId: data?.messages?.[0]?.id ?? null };
    }
  };
}

module.exports = { createWhatsAppGateway };
