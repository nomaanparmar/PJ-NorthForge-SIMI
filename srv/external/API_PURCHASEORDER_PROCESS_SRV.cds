/**
 * Hand-authored subset of the SAP-delivered API_PURCHASEORDER_PROCESS_SRV OData v2 service
 * (SAP API Business Hub). In a real project this would be generated via
 *   `cds import API_PURCHASEORDER_PROCESS_SRV --as cds`
 * from the downloaded EDMX; trimmed here to the fields the triage agent actually reads,
 * to keep the mock/local-run footprint small.
 */
@cds.external
service API_PURCHASEORDER_PROCESS_SRV {

  entity A_PurchaseOrder {
    key PurchaseOrder     : String(10);
        CompanyCode       : String(4);
        Supplier          : String(10);
        PurchasingOrgani  : String(4);
        DocumentCurrency  : String(3);
        PurchaseOrderDate : Date;
        to_PurchaseOrderItem : Association to many A_PurchaseOrderItem on to_PurchaseOrderItem.PurchaseOrder = PurchaseOrder;
  }

  entity A_PurchaseOrderItem {
    key PurchaseOrder       : String(10);
    key PurchaseOrderItem   : String(5);
        Material            : String(18);
        OrderQuantity       : Decimal(13,3);
        OrderPriceUnit      : String(3);
        NetPriceAmount      : Decimal(15,2);
        TaxCode             : String(2);
        Plant               : String(4);
  }
}
