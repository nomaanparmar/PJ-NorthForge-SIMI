/**
 * Local stand-in for API_PURCHASEORDER_PROCESS_SRV (SAP API Business Hub), used only when
 * no real destination is configured (see fetchPurchaseOrderItem in invoice-service.js).
 * Mirrors the S/4 sandbox PO data used throughout the seeded demo invoices.
 */
const PURCHASE_ORDERS = {
  '4500001234': {
    CompanyCode: '1000', Supplier: '0000100234', PurchasingOrgani: '1000', DocumentCurrency: 'CAD', PurchaseOrderDate: '2026-07-20',
    items: {
      '10': { Material: 'STEEL-COIL-04', OrderQuantity: 110, OrderPriceUnit: 'EA', NetPriceAmount: 159.45, TaxCode: 'J1', Plant: '1010' },
      '20': { Material: 'STEEL-COIL-06', OrderQuantity: 80, OrderPriceUnit: 'EA', NetPriceAmount: 165.00, TaxCode: 'J1', Plant: '1010' }
    }
  },
  '4500001560': {
    CompanyCode: '1000', Supplier: '0000100567', PurchasingOrgani: '1000', DocumentCurrency: 'CAD', PurchaseOrderDate: '2026-06-02',
    items: {
      '20': { Material: 'BEARING-6205', OrderQuantity: 60, OrderPriceUnit: 'EA', NetPriceAmount: 141.90, TaxCode: 'S1', Plant: '1030' },
      '30': { Material: 'BEARING-6306', OrderQuantity: 100, OrderPriceUnit: 'EA', NetPriceAmount: 142.50, TaxCode: 'S1', Plant: '1030' }
    }
  },
  '4500001601': {
    CompanyCode: '1000', Supplier: '0000100891', PurchasingOrgani: '1000', DocumentCurrency: 'CAD', PurchaseOrderDate: '2026-05-11',
    items: {
      '10': { Material: 'COATING-EPOXY-20L', OrderQuantity: 190, OrderPriceUnit: 'L', NetPriceAmount: 88.00, TaxCode: 'B1', Plant: '1040' },
      '20': { Material: 'COATING-EPOXY-20L', OrderQuantity: 24, OrderPriceUnit: 'L', NetPriceAmount: 88.00, TaxCode: 'B1', Plant: '1040' }
    }
  },
  '4500001789': {
    CompanyCode: '1000', Supplier: '0000101045', PurchasingOrgani: '1000', DocumentCurrency: 'CAD', PurchaseOrderDate: '2026-07-30',
    items: { '10': { Material: 'HYD-PUMP-450', OrderQuantity: 5, OrderPriceUnit: 'EA', NetPriceAmount: 12500.00, TaxCode: 'J1', Plant: '1010' } }
  },
  '4500001890': {
    CompanyCode: '1000', Supplier: '0000100234', PurchasingOrgani: '1000', DocumentCurrency: 'CAD', PurchaseOrderDate: '2026-08-10',
    items: { '10': { Material: 'STEEL-PLATE-12', OrderQuantity: 200, OrderPriceUnit: 'EA', NetPriceAmount: 245.00, TaxCode: 'J1', Plant: '1010' } }
  },
  '4500001960': {
    CompanyCode: '1000', Supplier: '0000101045', PurchasingOrgani: '1000', DocumentCurrency: 'CAD', PurchaseOrderDate: '2026-08-15',
    items: { '10': { Material: 'HYD-VALVE-220', OrderQuantity: 40, OrderPriceUnit: 'EA', NetPriceAmount: 310.00, TaxCode: 'J1', Plant: '1010' } }
  },
  '4500002015': {
    CompanyCode: '1000', Supplier: '0000101289', PurchasingOrgani: '1000', DocumentCurrency: 'CAD', PurchaseOrderDate: '2026-08-18',
    items: { '10': { Material: 'RAIL-CLIP-A36', OrderQuantity: 500, OrderPriceUnit: 'EA', NetPriceAmount: 4.25, TaxCode: 'S1', Plant: '1030' } }
  }
}

async function fetchPurchaseOrderItem (poNumber, itemNumber) {
  const item = PURCHASE_ORDERS[poNumber]?.items?.[itemNumber]
  return item ? { PurchaseOrder: poNumber, PurchaseOrderItem: itemNumber, ...item } : null
}

module.exports = { fetchPurchaseOrderItem }
