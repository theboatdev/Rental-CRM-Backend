const PDFDocument = require('pdfkit');
const { fillPlaceholders } = require('../config/documents');

/**
 * The return receipt: the PDF bill a completed rental downloads as, issued
 * by the tenant to the renter. It confirms the vehicle came back and shows
 * what the rental details show: the renter and vehicle, the dates and
 * odometer, the charges and what was paid, the payments, custom fields and
 * notes, and both inspections with their photos.
 *
 * `renderReturnReceipt` is a pure function of the config and a `receipt`
 * (plain data, built by src/tenant/receipts.js for a real rental and by
 * ./sample.js for the admin dashboard's preview). `documents.returnReceipt`
 * decides the title, the texts and which parts appear.
 *
 * receipt = {
 *   code, bookingCode, source: 'COUNTER' | 'ONLINE',
 *   renter: { fullName, profileId, phone, details: [{ label, value }] },
 *   vehicle: { plateNumber, make, model, year },
 *   startDate, endDate: 'YYYY-MM-DD', returnedAt: Date, totalDays,
 *   dailyRate, totalAmount, depositAmount, paidAmount, depositRefunded,
 *   fullPayment: null | { at: Date, by },                 // staff's confirmation of full payment
 *   startMileage, endMileage,
 *   details: [{ label, value, wide? }],                  // custom fields and notes, as text
 *   inspections: [{ title, record: null | { at, by, odometer, points, notes,
 *                   photos: [{ point, image: Buffer | null, placeholder? }] } }],
 *   payments: null | [{ receiptNumber, paidAt, type, method, reference, amount }],  // refunds negative
 *   issuedBy, issuedAt: Date
 * }
 * `logo` and the photos' `image`s are JPEG or PNG bytes; anything else is left out.
 */

// ---------------------------------------------------------------------------
// Text. The standard PDF fonts only have the Windows-1252 characters.
// ---------------------------------------------------------------------------

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';

const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d,
  0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178
]);
const SUBSTITUTES = { ' ': ' ', ' ': ' ', ' ': ' ', '−': '-', '→': '->', '←': '<-', '­': '' };
const printable = (code) => code === 10 || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS.has(code);

/** `value` as text the PDF fonts can draw: accents dropped where needed, anything else as "?". */
function pdfText(value) {
  let out = '';
  for (const char of String(value ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').normalize('NFC')) {
    if (printable(char.codePointAt(0))) out += char;
    else if (char in SUBSTITUTES) out += SUBSTITUTES[char];
    else {
      const base = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += base && [...base].every((c) => printable(c.codePointAt(0))) ? base : '?';
    }
  }
  return out;
}

/** Formatters for the tenant's locale, like the tenant app's (src/lib/format.ts there). */
function formattersFor({ dateLocale, currency, timezone, distanceUnit }) {
  const currencyFormat = (currencyDisplay) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency, currencyDisplay, maximumFractionDigits: 0 });
  const symbol = currencyFormat('symbol');
  // A symbol the fonts lack (₹, ₨…) is shown as the currency code instead.
  const symbolText = symbol.formatToParts(1).find((part) => part.type === 'currency')?.value ?? '';
  const money = [...symbolText].every((c) => printable(c.codePointAt(0))) ? symbol : currencyFormat('code');
  // Calendar dates are UTC midnight, so they're formatted in UTC to keep the day.
  const day = new Intl.DateTimeFormat(dateLocale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const localDay = new Intl.DateTimeFormat(dateLocale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone });
  const dateTime = new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone });
  const number = new Intl.NumberFormat(dateLocale);
  return {
    money: (amount) => pdfText(money.format(amount)),
    day: (date) => pdfText(day.format(new Date(`${date}T00:00:00Z`))),
    /** The tenant's calendar day of a timestamp. */
    dayOf: (date) => pdfText(localDay.format(new Date(date))),
    dateTime: (date) => pdfText(dateTime.format(new Date(date))),
    number: (value) => pdfText(number.format(value)),
    distance: (value) => pdfText(`${number.format(value)} ${distanceUnit}`)
  };
}

// ---------------------------------------------------------------------------
// The receipt's data
// ---------------------------------------------------------------------------

const PAYMENT_TYPE_LABELS = {
  ADVANCE: 'Booking advance',
  RENTAL: 'Rental payment',
  DEPOSIT: 'Security deposit',
  DAMAGE: 'Damage charge',
  LATE_FEE: 'Late fee',
  REFUND: 'Refund'
};

const labelOf = (config, section, key) => config.fields[section].builtIn[key]?.label ?? key;
const listLabel = (config, list, key) => config.lists[list].find((item) => item.key === key)?.label ?? key;

/** A renter's email, address and country, for the built-in renter fields that are on. */
function renterDetails(config, renter) {
  return ['email', 'address', 'country']
    .filter((key) => renter[key] && config.fields.renters.builtIn[key]?.active)
    .map((key) => ({ label: labelOf(config, 'renters', key), value: renter[key] }));
}

/** A custom field value as text: dates and numbers in the tenant's locale, option labels, "Attached" for a file. */
function customValueText(field, value, format) {
  if (typeof value === 'object' && value !== null) return `Attached (${String(value.format ?? 'file').toUpperCase()})`;
  switch (field.type) {
    case 'boolean':
      return value === true ? 'Yes' : 'No';
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? format.day(value) : String(value);
    case 'number':
      return typeof value === 'number' ? format.number(value) : String(value);
    case 'select':
      return field.options.find((option) => option.key === value)?.label ?? String(value);
    default:
      return String(value);
  }
}

/** The rental's active custom fields that have a value, then its notes (when the notes field is on). */
function rentalDetails(config, { customFields = {}, notes = '' }, format) {
  const details = config.fields.rentals.custom
    .filter((field) => field.active && customFields[field.key] !== undefined && customFields[field.key] !== '')
    .map((field) => ({ label: field.label, value: customValueText(field, customFields[field.key], format), wide: field.type === 'longText' }));
  if (notes && config.fields.rentals.builtIn.notes?.active) details.push({ label: labelOf(config, 'rentals', 'notes'), value: notes, wide: true });
  return details;
}

/** What the receipt shows of `receipt`, given the settings: parts that are off are dropped. */
function visibleParts(receipt, settings) {
  return {
    details: settings.showCustomFields ? receipt.details : [],
    inspections: settings.showInspections
      ? receipt.inspections.map(({ title, record }) => ({ title, record: record && { ...record, photos: settings.showInspectionPhotos ? record.photos : [] } }))
      : [],
    payments: settings.showPayments ? receipt.payments : null
  };
}

/**
 * The money summary. A refunded deposit no longer counts towards what's
 * owed, so a settled rental reads "Paid in full".
 */
function settlementOf(receipt) {
  const deposit = receipt.depositRefunded ? 0 : receipt.depositAmount;
  const total = receipt.totalAmount + deposit;
  return { total, paid: receipt.paidAmount, balance: total - receipt.paidAmount };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Whether the PDF can embed these bytes: JPEG or PNG. */
const isEmbeddableImage = (bytes) =>
  Buffer.isBuffer(bytes) && bytes.length > 8 && ((bytes[0] === 0xff && bytes[1] === 0xd8) || bytes.subarray(0, 8).equals(PNG_SIGNATURE));

const receiptFilename = (code) => `${String(code).replace(/[^A-Za-z0-9-]+/g, '_')}-return-receipt.pdf`;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const COLORS = {
  ink: '#111827',
  muted: '#6B7280',
  line: '#E5E7EB',
  paper: '#F9FAFB',
  success: '#047857',
  successTint: '#ECFDF5',
  danger: '#B91C1C',
  placeholder: '#E5E7EB'
};
const MARGIN = 44;
/** Space kept at the bottom of every page for the page footer. */
const FOOTER_SPACE = 30;

/** `hex` mixed with white; `amount` 1 is white. */
function tint(hex, amount) {
  const value = Number.parseInt(hex.slice(1), 16);
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  return `#${[value >> 16, (value >> 8) & 255, value & 255].map((channel) => mix(channel).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Renders the return receipt to PDF bytes. `compress: false` keeps the
 * content streams readable, for tests.
 */
function renderReturnReceipt({ config, receipt, logo = null }, { compress = true } = {}) {
  const settings = config.documents.returnReceipt;
  const { branding } = config;
  const format = formattersFor(config.locale);
  const brand = branding.primaryColor;
  const parts = visibleParts(receipt, settings);
  const vehicleName = `${receipt.vehicle.make} ${receipt.vehicle.model}`.trim();
  const placeholders = {
    businessName: branding.displayName,
    renterName: receipt.renter.fullName,
    vehicle: vehicleName,
    plateNumber: receipt.vehicle.plateNumber,
    rentalCode: receipt.code,
    returnDate: format.dayOf(receipt.returnedAt)
  };

  const doc = new PDFDocument({
    size: settings.paperSize,
    margin: MARGIN,
    bufferPages: true,
    compress,
    info: {
      Title: pdfText(`${settings.title} ${receipt.code}`),
      Author: pdfText(branding.displayName),
      Subject: pdfText(`${receipt.code}: ${vehicleName} (${receipt.vehicle.plateNumber}) returned by ${receipt.renter.fullName}`),
      Creator: pdfText(branding.displayName),
      CreationDate: receipt.issuedAt
    }
  });

  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  let y = MARGIN;

  const bottom = () => doc.page.height - MARGIN - FOOTER_SPACE;
  /** Starts a new page unless `height` still fits on this one. */
  const ensure = (height) => {
    if (y + height > bottom()) {
      doc.addPage();
      y = MARGIN;
    }
  };
  const measure = (text, textWidth, { font = REGULAR, size = 9, lineGap = 1.5, characterSpacing = 0 } = {}) => {
    doc.font(font).fontSize(size);
    return doc.heightOfString(pdfText(text), { width: textWidth, lineGap, characterSpacing });
  };
  /** Writes `text` at (x, top) and returns its height. */
  const write = (text, x, top, textWidth, { font = REGULAR, size = 9, color = COLORS.ink, align = 'left', lineGap = 1.5, characterSpacing = 0 } = {}) => {
    doc.font(font).fontSize(size).fillColor(color);
    doc.text(pdfText(text), x, top, { width: textWidth, align, lineGap, characterSpacing });
    return measure(text, textWidth, { font, size, lineGap, characterSpacing });
  };
  const caption = (text, x, top, textWidth, options = {}) => write(String(text).toUpperCase(), x, top, textWidth, { font: BOLD, size: 7, color: COLORS.muted, characterSpacing: 0.6, ...options });
  const rule = (top, color = COLORS.line, weight = 0.75) => doc.moveTo(left, top).lineTo(left + width, top).lineWidth(weight).strokeColor(color).stroke();
  /** A section heading, kept on the same page as the first `keepWith` points of what follows it. */
  const heading = (text, keepWith = 50) => {
    ensure(22 + keepWith);
    y += write(text, left, y, width, { font: BOLD, size: 10.5 }) + 6;
  };
  /** Draws an image in a box: within it, centred, or a grey placeholder when the bytes can't be drawn. */
  const imageBox = (bytes, x, top, boxWidth, boxHeight, placeholder) => {
    if (isEmbeddableImage(bytes)) {
      try {
        doc.image(bytes, x, top, { fit: [boxWidth, boxHeight], align: 'center', valign: 'center' });
        return;
      } catch {
        // A corrupt image falls through to the placeholder.
      }
    }
    doc.rect(x, top, boxWidth, boxHeight).fill(COLORS.placeholder);
    write(placeholder, x, top + boxHeight / 2 - 4, boxWidth, { size: 7, color: COLORS.muted, align: 'center' });
  };
  const checkMark = (x, top, size, color) => {
    doc
      .lineWidth(Math.max(1, size / 6))
      .strokeColor(color)
      .moveTo(x, top + size * 0.55)
      .lineTo(x + size * 0.38, top + size * 0.9)
      .lineTo(x + size, top + size * 0.15)
      .stroke();
  };

  // A table: header row tinted with the brand colour, rows with a rule under each. The header repeats on a new page.
  const table = (columns, rows) => {
    const padding = 6;
    const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
    const flexible = columns.filter((column) => !column.width).length;
    const widths = columns.map((column) => column.width ?? (width - fixed) / flexible);
    const cellWidth = (index) => widths[index] - padding * 2;
    const xOf = (index) => left + widths.slice(0, index).reduce((sum, w) => sum + w, 0);
    const drawHeader = () => {
      const height = 20;
      doc.rect(left, y, width, height).fill(tint(brand, 0.88));
      columns.forEach((column, index) => caption(column.title, xOf(index) + padding, y + 7, cellWidth(index), { color: COLORS.ink, align: column.align ?? 'left' }));
      y += height;
    };
    ensure(46);
    drawHeader();
    for (const row of rows) {
      const height = Math.max(...row.cells.map((cell, index) => measure(cell, cellWidth(index), { font: row.bold ? BOLD : REGULAR }))) + padding * 2;
      if (y + height > bottom()) {
        doc.addPage();
        y = MARGIN;
        drawHeader();
      }
      row.cells.forEach((cell, index) =>
        write(cell, xOf(index) + padding, y + padding, cellWidth(index), { font: row.bold ? BOLD : REGULAR, align: columns[index].align ?? 'left', color: row.color ?? COLORS.ink })
      );
      y += height;
      rule(y);
    }
  };

  // --- Header: the business on the left, the document on the right -------------------------------------------
  const header = () => {
    const leftWidth = width * 0.55;
    const rightX = left + width * 0.58;
    const rightWidth = width * 0.42;
    let leftY = y;
    if (isEmbeddableImage(logo)) {
      try {
        const image = doc.openImage(logo);
        const scale = Math.min(150 / image.width, 48 / image.height, 1);
        doc.image(image, left, leftY, { width: image.width * scale, height: image.height * scale });
        leftY += image.height * scale + 8;
      } catch {
        // No logo then.
      }
    }
    leftY += write(branding.displayName, left, leftY, leftWidth, { font: BOLD, size: 15 }) + 2;
    if (branding.tagline) leftY += write(branding.tagline, left, leftY, leftWidth, { size: 8.5, color: COLORS.muted }) + 2;
    for (const line of settings.issuerDetails) leftY += write(line, left, leftY, leftWidth, { size: 8.5 }) + 1;
    const contact = [branding.supportPhone, branding.supportEmail].filter(Boolean).join('   ·   ');
    if (contact) leftY += write(contact, left, leftY, leftWidth, { size: 8.5, color: COLORS.muted });

    let rightY = y;
    rightY += write(settings.title, rightX, rightY, rightWidth, { font: BOLD, size: 14, color: brand, align: 'right' }) + 8;
    const meta = [
      ['Invoice no.', receipt.code],
      ...(receipt.bookingCode ? [['Booking ref.', receipt.bookingCode]] : []),
      ['Issued', format.dayOf(receipt.issuedAt)],
      ['Renter ID', receipt.renter.profileId]
    ];
    for (const [label, value] of meta) {
      write(label, rightX, rightY, rightWidth * 0.45, { size: 8.5, color: COLORS.muted });
      rightY += write(value, rightX + rightWidth * 0.45, rightY, rightWidth * 0.55, { font: BOLD, size: 8.5, align: 'right' }) + 3;
    }
    y = Math.max(leftY, rightY) + 12;
    doc.rect(left, y, width, 2).fill(brand);
    y += 16;
  };

  // --- The return confirmation ---------------------------------------------------------------------------------
  const confirmation = () => {
    const statement = fillPlaceholders(settings.returnStatement, placeholders);
    const textX = left + 44;
    const textWidth = width - 56;
    const height = Math.max(measure('x', textWidth, { font: BOLD, size: 8.5 }) + 4 + measure(statement, textWidth, { size: 9.5 }), 24) + 22;
    ensure(height);
    doc.roundedRect(left, y, width, height, 4).fill(COLORS.successTint);
    doc.circle(left + 22, y + 22, 11).fill(COLORS.success);
    checkMark(left + 16.5, y + 17, 11, '#FFFFFF');
    let textY = y + 11;
    textY += caption('Vehicle returned', textX, textY, textWidth, { size: 8.5, color: COLORS.success }) + 4;
    write(statement, textX, textY, textWidth, { size: 9.5 });
    y += height + 18;
  };

  // --- Billed to, and the vehicle ------------------------------------------------------------------------------
  const parties = () => {
    const columnWidth = (width - 24) / 2;
    const block = (x, title, lines) => {
      let blockY = y + caption(title, x, y, columnWidth) + 4;
      for (const [text, options] of lines) blockY += write(text, x, blockY, columnWidth, options) + 2;
      return blockY;
    };
    const { renter, vehicle } = receipt;
    ensure(80);
    const renterBottom = block(left, `Billed to (${labelOf(config, 'rentals', 'renter')})`, [
      [renter.fullName, { font: BOLD, size: 10.5 }],
      [`${renter.profileId}   ·   ${renter.phone}`, { color: COLORS.muted }],
      ...renter.details.map((detail) => [`${detail.label}: ${detail.value}`, {}])
    ]);
    const vehicleBottom = block(left + columnWidth + 24, labelOf(config, 'rentals', 'vehicle'), [
      [vehicle.plateNumber, { font: BOLD, size: 10.5 }],
      [[vehicleName, vehicle.year].filter(Boolean).join(' · '), { color: COLORS.muted }]
    ]);
    y = Math.max(renterBottom, vehicleBottom) + 14;
  };

  // --- The rental period and odometer, as a grid of facts ------------------------------------------------------
  const facts = () => {
    const distance = receipt.endMileage != null && receipt.startMileage != null ? receipt.endMileage - receipt.startMileage : null;
    const items = [
      [labelOf(config, 'rentals', 'startDate'), format.day(receipt.startDate)],
      [labelOf(config, 'rentals', 'endDate'), format.day(receipt.endDate)],
      ['Returned on', format.dateTime(receipt.returnedAt)],
      ['Rental days', format.number(receipt.totalDays)],
      ['Odometer out', receipt.startMileage != null ? format.distance(receipt.startMileage) : '—'],
      ['Odometer in', receipt.endMileage != null ? format.distance(receipt.endMileage) : '—'],
      ['Distance driven', distance != null ? format.distance(distance) : '—'],
      ['Booked via', receipt.source === 'ONLINE' ? 'Guest portal' : 'Counter']
    ];
    const columns = 4;
    const cellWidth = width / columns;
    const rowHeight = 32;
    const height = Math.ceil(items.length / columns) * rowHeight + 8;
    ensure(height);
    doc.rect(left, y, width, height).lineWidth(0.75).fillAndStroke(COLORS.paper, COLORS.line);
    items.forEach(([label, value], index) => {
      const x = left + (index % columns) * cellWidth + 10;
      const top = y + 8 + Math.floor(index / columns) * rowHeight;
      caption(label, x, top, cellWidth - 16);
      write(value, x, top + 11, cellWidth - 16, { font: BOLD, size: 9.5 });
    });
    y += height + 20;
  };

  // --- Charges and the settlement -----------------------------------------------------------------------------
  const charges = () => {
    heading('Charges');
    const rows = [
      {
        cells: [
          `Vehicle rental: ${vehicleName} (${receipt.vehicle.plateNumber})`,
          `${format.number(receipt.totalDays)} ${receipt.totalDays === 1 ? 'day' : 'days'}`,
          format.money(receipt.dailyRate),
          format.money(receipt.totalAmount)
        ]
      }
    ];
    if (receipt.depositAmount > 0) {
      rows.push({ cells: [`${labelOf(config, 'rentals', 'depositAmount')} (refundable)`, '', '', format.money(receipt.depositAmount)] });
      if (receipt.depositRefunded) rows.push({ cells: [`${labelOf(config, 'rentals', 'depositAmount')} refunded`, '', '', format.money(-receipt.depositAmount)] });
    }
    table(
      [
        { title: 'Description' },
        { title: 'Quantity', width: 70, align: 'right' },
        { title: labelOf(config, 'rentals', 'dailyRate'), width: 95, align: 'right' },
        { title: 'Amount', width: 95, align: 'right' }
      ],
      rows
    );

    const { total, paid, balance } = settlementOf(receipt);
    const lines = [
      ['Total', format.money(total), COLORS.ink],
      ['Paid (net of refunds)', format.money(paid), COLORS.ink],
      balance > 0
        ? ['Balance due', format.money(balance), COLORS.danger]
        : balance < 0
          ? ['Credit to the renter', format.money(-balance), COLORS.success]
          : ['Balance', 'Paid in full', COLORS.success]
    ];
    const boxWidth = 250;
    const boxX = left + width - boxWidth;
    ensure(lines.length * 18 + 16);
    y += 8;
    lines.forEach(([label, value, color], index) => {
      const last = index === lines.length - 1;
      if (last) {
        doc.moveTo(boxX, y).lineTo(boxX + boxWidth, y).lineWidth(1).strokeColor(COLORS.ink).stroke();
        y += 5;
      }
      const font = last ? BOLD : REGULAR;
      const size = last ? 10.5 : 9;
      write(label, boxX + 6, y, boxWidth * 0.5, { font, size, color: last ? color : COLORS.muted });
      y += write(value, boxX + boxWidth * 0.5, y, boxWidth * 0.5 - 6, { font, size, color, align: 'right' }) + 5;
    });
    if (receipt.fullPayment) {
      const confirmed = `Full payment confirmed ${format.dateTime(receipt.fullPayment.at)}${receipt.fullPayment.by ? ` by ${receipt.fullPayment.by}` : ''}`;
      ensure(14);
      y += write(confirmed, boxX + 6, y, boxWidth - 12, { size: 7.5, color: COLORS.success, align: 'right' }) + 2;
    }
    y += 14;
  };

  // --- Payments ------------------------------------------------------------------------------------------------
  const payments = () => {
    if (!parts.payments) return;
    heading('Payments');
    if (parts.payments.length === 0) {
      y += write('No payments recorded.', left, y, width, { color: COLORS.muted }) + 16;
      return;
    }
    table(
      [
        { title: 'Receipt', width: 88 },
        { title: 'Date', width: 98 },
        { title: 'Type' },
        { title: 'Method', width: 78 },
        { title: 'Reference', width: 66 },
        { title: 'Amount', width: 78, align: 'right' }
      ],
      parts.payments.map((payment) => ({
        cells: [payment.receiptNumber, format.dateTime(payment.paidAt), payment.type, payment.method, payment.reference || '—', format.money(payment.amount)]
      }))
    );
    y += 18;
  };

  // --- Custom fields and notes ----------------------------------------------------------------------------------
  const details = () => {
    if (parts.details.length === 0) return;
    const columnWidth = (width - 24) / 2;
    const narrow = parts.details.filter((detail) => !detail.wide);
    const wide = parts.details.filter((detail) => detail.wide);
    const [first] = [...narrow, ...wide];
    heading('Rental details', measure(first.value, first.wide ? width : columnWidth, { size: 9.5 }) + 14);
    for (let index = 0; index < narrow.length; index += 2) {
      const pair = narrow.slice(index, index + 2);
      const height = Math.max(...pair.map((detail) => measure(detail.value, columnWidth, { size: 9.5 }))) + 14;
      ensure(height);
      pair.forEach((detail, column) => {
        const x = left + column * (columnWidth + 24);
        caption(detail.label, x, y, columnWidth);
        write(detail.value, x, y + 10, columnWidth, { size: 9.5 });
      });
      y += height + 6;
    }
    for (const detail of wide) {
      const height = measure(detail.value, width, { size: 9.5 }) + 14;
      ensure(height);
      caption(detail.label, left, y, width);
      write(detail.value, left, y + 10, width, { size: 9.5 });
      y += height + 6;
    }
    y += 12;
  };

  // --- Inspections, with their photos ------------------------------------------------------------------------
  const inspections = () => {
    for (const { title, record } of parts.inspections) {
      // With its date line and the first row of points.
      heading(title, 44);
      if (!record) {
        y += write('Not recorded.', left, y, width, { color: COLORS.muted }) + 16;
        continue;
      }
      const meta = [format.dateTime(record.at), record.by, record.odometer != null ? `Odometer ${format.distance(record.odometer)}` : null].filter(Boolean).join('   ·   ');
      y += write(meta, left, y, width, { size: 8.5, color: COLORS.muted }) + 6;

      const columns = 3;
      const columnWidth = width / columns;
      for (let index = 0; index < record.points.length; index += columns) {
        const row = record.points.slice(index, index + columns);
        const height = Math.max(...row.map((point) => measure(point, columnWidth - 20, { size: 8.5 }))) + 4;
        ensure(height);
        row.forEach((point, column) => {
          const x = left + column * columnWidth;
          checkMark(x + 1, y + 1.5, 7, COLORS.success);
          write(point, x + 13, y, columnWidth - 20, { size: 8.5 });
        });
        y += height;
      }
      if (record.points.length === 0) y += write('No points checked.', left, y, width, { size: 8.5, color: COLORS.muted });
      if (record.notes) {
        y += 4;
        const height = measure(`Notes: ${record.notes}`, width, { size: 8.5 });
        ensure(height);
        y += write(`Notes: ${record.notes}`, left, y, width, { size: 8.5 });
      }
      y += 8;

      const perRow = 4;
      const gap = 10;
      const photoWidth = (width - gap * (perRow - 1)) / perRow;
      const photoHeight = photoWidth * 0.75;
      for (let index = 0; index < record.photos.length; index += perRow) {
        ensure(photoHeight + 22);
        record.photos.slice(index, index + perRow).forEach((photo, column) => {
          const x = left + column * (photoWidth + gap);
          imageBox(photo.image, x, y, photoWidth, photoHeight, photo.placeholder ?? 'Photo unavailable');
          write(photo.point, x, y + photoHeight + 3, photoWidth, { size: 7.5, color: COLORS.muted });
        });
        y += photoHeight + 20;
      }
      y += 10;
    }
  };

  // --- Signatures and the closing text ---------------------------------------------------------------------------
  const closing = () => {
    if (settings.showSignatures) {
      ensure(80);
      y += 34;
      const columnWidth = (width - 48) / 2;
      [`${labelOf(config, 'rentals', 'renter')}: ${receipt.renter.fullName}`, `For ${branding.displayName}`].forEach((label, column) => {
        const x = left + column * (columnWidth + 48);
        doc.moveTo(x, y).lineTo(x + columnWidth, y).lineWidth(0.75).strokeColor(COLORS.ink).stroke();
        write(label, x, y + 5, columnWidth, { size: 8.5 });
        write('Signature and date', x, y + 17, columnWidth, { size: 7.5, color: COLORS.muted });
      });
      y += 40;
    }
    const footer = fillPlaceholders(settings.footer, placeholders);
    if (footer) {
      const height = measure(footer, width, { size: 8.5 }) + 16;
      ensure(height);
      y += 12;
      write(footer, left, y, width, { size: 8.5, color: COLORS.muted, align: 'center' });
    }
  };

  // --- Every page: who issued it, and the page number ---------------------------------------------------------
  const pageFooters = () => {
    const { start, count } = doc.bufferedPageRange();
    const issued = `${receipt.code} · Issued ${format.dateTime(receipt.issuedAt)}${receipt.issuedBy ? ` by ${receipt.issuedBy}` : ''}`;
    for (let index = start; index < start + count; index += 1) {
      doc.switchToPage(index);
      // Writing inside the bottom margin would otherwise start a new page.
      const { bottom: margin } = doc.page.margins;
      doc.page.margins.bottom = 0;
      const top = doc.page.height - MARGIN - 12;
      rule(top - 6);
      write(issued, left, top, width * 0.75, { size: 7.5, color: COLORS.muted });
      write(`Page ${index - start + 1} of ${count}`, left + width * 0.75, top, width * 0.25, { size: 7.5, color: COLORS.muted, align: 'right' });
      doc.page.margins.bottom = margin;
    }
  };

  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    header();
    confirmation();
    parties();
    facts();
    charges();
    payments();
    details();
    inspections();
    closing();
    pageFooters();
    doc.end();
  });
}

module.exports = {
  renderReturnReceipt,
  receiptFilename,
  formattersFor,
  renterDetails,
  rentalDetails,
  listLabel,
  settlementOf,
  isEmbeddableImage,
  pdfText,
  PAYMENT_TYPE_LABELS
};
