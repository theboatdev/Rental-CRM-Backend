const { z } = require('zod');
const { PAYMENT_TYPES } = require('../models/tenant/enums');
const { conflict, invalid } = require('../platform/errors');
const { parse, findOr404, inTransaction, lock, nextCode, todayIn, IdSchema, activeListKey } = require('./common');
const { presentPayment } = require('./presenters');
const { recordAudit } = require('./audit');

const PaymentInputSchema = (config) =>
  z.strictObject({
    rentalId: IdSchema,
    type: z.enum(PAYMENT_TYPES),
    method: activeListKey(config, 'paymentMethods'),
    amount: z.number().positive(),
    transactionReference: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(500).default('')
  });

const VoidInputSchema = z.strictObject({ reason: z.string().trim().min(3).max(300) });

const POPULATE = { rental: 'code', renter: 'profileId fullName phone' };

/** A refund takes money out of what the renter has paid; everything else adds to it. */
const signOf = (type) => (type === 'REFUND' ? -1 : 1);

/**
 * Inside a transaction (with the rental locked): records a payment against a
 * rental and keeps `rental.paidAmount` in step. Receipts are numbered with
 * the config's prefixes: `advance` for advances, `receipt` for the rest.
 */
async function recordPaymentIn(ctx, session, rental, { type, method, amount, transactionReference, notes = '' }) {
  const paid = rental.paidAmount ?? 0;
  if (rental.status === 'CANCELLED' && type !== 'REFUND') {
    throw conflict(`${rental.code} was cancelled, so only refunds can be recorded against it`);
  }
  if (type === 'REFUND' && amount > paid) {
    throw invalid(`The refund is more than the ${paid} received for ${rental.code}`, [{ path: 'amount', message: 'More than was paid' }]);
  }
  if (rental.status === 'RESERVED' && type !== 'REFUND' && paid + amount > rental.totalAmount + rental.depositAmount) {
    throw invalid('That is more than the outstanding rental and deposit together', [{ path: 'amount', message: 'More than is owed' }]);
  }

  const prefixes = ctx.config.rules.codePrefixes;
  const isAdvance = type === 'ADVANCE';
  const receiptNumber = await nextCode(ctx, {
    prefix: isAdvance ? prefixes.advance : prefixes.receipt,
    sequence: isAdvance ? 'advance' : 'receipt',
    year: todayIn(ctx.timezone).slice(0, 4),
    session
  });
  const [payment] = await ctx.models.Payment.create(
    [
      {
        receiptNumber,
        rental: rental._id,
        renter: rental.renter?._id ?? rental.renter,
        type,
        method,
        amount,
        transactionReference,
        notes,
        paidAt: new Date(),
        receivedBy: ctx.actor
      }
    ],
    { session }
  );
  const refundsCompleted = type === 'REFUND' && rental.status === 'COMPLETED';
  await ctx.models.Rental.updateOne(
    { _id: rental._id },
    { $inc: { paidAmount: signOf(type) * amount }, ...(refundsCompleted ? { $set: { depositRefunded: true } } : {}) },
    { session }
  );
  return payment;
}

/** The payment ledger: receipts, advances, deposits and refunds. Entries are voided, never deleted. */
function createPayments() {
  async function getPayment(ctx, paymentId) {
    return presentPayment(await findOr404(ctx.models.Payment, paymentId, 'Payment', { populate: POPULATE }));
  }

  return {
    /** Newest first; `rentalId` narrows it to one rental. */
    async listPayments(ctx, { rentalId } = {}) {
      const filter = IdSchema.safeParse(rentalId).success ? { rental: rentalId } : {};
      let query = ctx.models.Payment.find(filter).sort({ paidAt: -1 });
      for (const [path, select] of Object.entries(POPULATE)) query = query.populate(path, select);
      return (await query.lean()).map(presentPayment);
    },

    async recordPayment(ctx, input) {
      const data = parse(PaymentInputSchema(ctx.config), input);
      let paymentId;
      let summary;
      await inTransaction(ctx, async (session) => {
        await lock(ctx, `rental:${data.rentalId}`, session);
        const rental = await findOr404(ctx.models.Rental, data.rentalId, 'Rental', { session });
        const payment = await recordPaymentIn(ctx, session, rental, data);
        paymentId = payment._id;
        summary = `${payment.receiptNumber}: ${data.type} of ${data.amount} for ${rental.code}`;
      });
      await recordAudit(ctx, { action: 'payment.recorded', entityType: 'payment', entityId: String(paymentId), summary });
      return getPayment(ctx, String(paymentId));
    },

    /** Marks an entry void with a reason and takes it back out of the rental's paid amount. */
    async voidPayment(ctx, paymentId, input) {
      const { reason } = parse(VoidInputSchema, input);
      let summary;
      await inTransaction(ctx, async (session) => {
        const payment = await findOr404(ctx.models.Payment, paymentId, 'Payment', { session });
        if (payment.voidedAt) throw conflict(`${payment.receiptNumber} is already void`);
        await lock(ctx, `rental:${payment.rental}`, session);
        await ctx.models.Payment.updateOne(
          { _id: payment._id, voidedAt: null },
          { $set: { voidedAt: new Date(), voidedBy: ctx.actor, voidReason: reason } },
          { session }
        );
        await ctx.models.Rental.updateOne({ _id: payment.rental }, { $inc: { paidAmount: -signOf(payment.type) * payment.amount } }, { session });
        summary = `Voided ${payment.receiptNumber}: ${reason}`;
      });
      await recordAudit(ctx, { action: 'payment.voided', entityType: 'payment', entityId: String(paymentId), summary });
      return getPayment(ctx, paymentId);
    }
  };
}

module.exports = { createPayments, recordPaymentIn, signOf };
