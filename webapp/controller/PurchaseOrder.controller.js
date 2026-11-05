sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "com/ewm/zrfinbound/model/inboundDelivery"
], (Controller, JSONModel, MessageBox, inboundDelivery) => {
    "use strict";

    return Controller.extend("com.ewm.zrfinbound.controller.PurchaseOrder", {
        onInit() {
            this.getView().setModel(new JSONModel({
                purchaseOrder: "",
                deliveries: [],
                busy: false
            }), "view");

            this.getOwnerComponent().getRouter().getRoute("RoutePurchaseOrder")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched(oEvent) {
            const sPurchaseOrder = oEvent.getParameter("arguments").purchaseOrder;
            const oModel = this.getView().getModel("view");
            oModel.setData({ purchaseOrder: sPurchaseOrder, deliveries: [], busy: true });

            // the service has no purchase order on the delivery header, so collect the deliveries from their items
            inboundDelivery.readByPurchaseOrder(this.getOwnerComponent().getModel(), sPurchaseOrder).then((aItems) => {
                oModel.setProperty("/deliveries", this._groupByDelivery(aItems));
                oModel.setProperty("/busy", false);
            }, (oError) => {
                oModel.setProperty("/busy", false);
                MessageBox.error(this._getText("backendError", [oError.status || "", oError.message || ""]));
            });
        },

        _groupByDelivery(aItems) {
            const mDeliveries = {};
            aItems.forEach((oItem) => {
                const oDelivery = mDeliveries[oItem.InboundDelivery] || (mDeliveries[oItem.InboundDelivery] = {
                    InboundDelivery: oItem.InboundDelivery,
                    Plant: oItem.Plant,
                    itemCount: 0
                });
                oDelivery.itemCount++;
            });
            return Object.values(mDeliveries).sort((a, b) => a.InboundDelivery.localeCompare(b.InboundDelivery));
        },

        formatListHeader(aDeliveries) {
            return this._getText("inboundDeliveries", [(aDeliveries || []).length]);
        },

        onDeliveryPress(oEvent) {
            const oModel = this.getView().getModel("view");
            this.getOwnerComponent().getRouter().navTo("RouteDeliveryDetail", {
                purchaseOrder: oModel.getProperty("/purchaseOrder"),
                delivery: oEvent.getSource().getBindingContext("view").getProperty("InboundDelivery")
            });
        },

        onNavBack() {
            this.getOwnerComponent().getRouter().navTo("RouteView1", {}, true);
        },

        _getText(sKey, aArgs) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        }
    });
});
