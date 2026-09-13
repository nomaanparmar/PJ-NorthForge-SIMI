/**
 * Local stand-in for the S/4 goods-receipt lookup (A_MaterialDocument), used only
 * for MISSING_GR exceptions. Mirrors the pattern in po-mock.js: keyed by
 * PO+item, absence of an entry means no GR has been posted yet.
 */
const GOODS_RECEIPTS = {
  // 5100000201 (PO 4500001789/10) intentionally has no entry here — that
  // invoice genuinely has no GR posted yet. This one demonstrates the other
  // branch: a GR that has since been posted (5100000342, PO 4500002015/10).
  '4500002015/10': { grDocument: '5000012345', quantityReceived: 500, postingDate: '2026-08-20' }
}

async function checkGoodsReceipt (poNumber, itemNumber) {
  return GOODS_RECEIPTS[`${poNumber}/${itemNumber}`] || null
}

module.exports = { checkGoodsReceipt }
