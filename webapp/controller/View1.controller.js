sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ndc/BarcodeScanner",
    "com/ewm/zrfinbound/model/inboundDelivery",
    "com/ewm/zrfinbound/model/rfHuInbound"
], (Controller, JSONModel, MessageToast, MessageBox, BarcodeScanner, inboundDelivery, rfHuInbound) => {
    "use strict";

    // index of the radio button selected for the delivery scan
    const MODE_SERIALIZATION = 0;
    const MODE_APPROVAL = 1;

    return Controller.extend("com.ewm.zrfinbound.controller.View1", {
        onInit() {
            this.getView().setModel(new JSONModel({
                mode: MODE_SERIALIZATION,
                purchaseOrder: "",
                purchaseOrderState: "None",
                delivery: "",
                deliveryState: "None",
                busy: false
            }), "view");

            this.getOwnerComponent().getRouter().getRoute("RouteView1")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched() {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/purchaseOrder", "");
            oModel.setProperty("/purchaseOrderState", "None");
            oModel.setProperty("/delivery", "");
            oModel.setProperty("/deliveryState", "None");
            this._focus("poInput");
        },

        onAfterRendering() {
            this._focus("poInput");
        },

        _focus(sId) {
            // RF guns type into the focused field, so keep the cursor there
            setTimeout(() => this.byId(sId).focus(), 0);
        },

        // the mode stays selected when coming back, so a scanner can go on with the next delivery
        onModeSelect() {
            this._focusDelivery();
        },

        _focusDelivery() {
            this._focus("deliveryInput");
        },

        // the scan icon in an input opens the device camera and submits what it read
        _scan(sTitle, sProperty, fnSubmit) {
            BarcodeScanner.scan((oResult) => {
                if (oResult.cancelled) {
                    return;
                }
                this.getView().getModel("view").setProperty(sProperty, oResult.text || "");
                fnSubmit.call(this);
            }, () => this.onScanFail(), undefined, sTitle);
        },

        onPurchaseOrderScanPress() {
            this._scan(this._getText("scanPurchaseOrder"), "/purchaseOrder", this.onPurchaseOrderSubmit);
        },

        onPurchaseOrderSubmit() {
            const oModel = this.getView().getModel("view");
            const sPurchaseOrder = (oModel.getProperty("/purchaseOrder") || "").trim();

            // Enter fires both change and submit, so skip the second call while the first one is running
            if (oModel.getProperty("/busy")) {
                return;
            }
            if (!sPurchaseOrder) {
                oModel.setProperty("/purchaseOrderState", "Error");
                this._focus("poInput");
                return;
            }
            oModel.setProperty("/purchaseOrderState", "None");
            oModel.setProperty("/busy", true);

            // inbound delivery items carry the purchase order as their reference document
            inboundDelivery.readByPurchaseOrder(this.getOwnerComponent().getModel(), sPurchaseOrder, 1).then((aItems) => {
                oModel.setProperty("/busy", false);
                if (!aItems.length) {
                    oModel.setProperty("/purchaseOrderState", "Error");
                    MessageToast.show(this._getText("purchaseOrderNotFound", [sPurchaseOrder]));
                    this._focus("poInput");
                    return;
                }
                this.getOwnerComponent().getRouter().navTo("RoutePurchaseOrder", {
                    purchaseOrder: sPurchaseOrder
                });
            }, (oError) => {
                oModel.setProperty("/busy", false);
                MessageBox.error(this._getText("backendError", [oError.status || "", oError.message || ""]));
                this._focus("poInput");
            });
        },

        onDeliveryScanPress() {
            this._scan(this._getText("scanDelivery"), "/delivery", this.onSubmit);
        },

        onScanFail() {
            MessageToast.show(this._getText("scanFailed"));
        },

        onSubmit() {
            const oModel = this.getView().getModel("view");
            const sDelivery = (oModel.getProperty("/delivery") || "").trim();

            if (!sDelivery) {
                oModel.setProperty("/deliveryState", "Error");
                this._focusDelivery();
                return;
            }
            oModel.setProperty("/deliveryState", "None");
            oModel.setProperty("/busy", true);

            // only continue when the backend has items for the scanned inbound delivery
            const oComponent = this.getOwnerComponent();
            inboundDelivery.readByDelivery(oComponent.getModel(), sDelivery, 1).then((aItems) => {
                if (!aItems.length) {
                    oModel.setProperty("/busy", false);
                    oModel.setProperty("/deliveryState", "Error");
                    MessageToast.show(this._getText("deliveryNotFound", [sDelivery]));
                    this._focusDelivery();
                    return undefined;
                }
                // the delivery scan submits right away, so the selected mode decides the screen
                if (oModel.getProperty("/mode") === MODE_APPROVAL) {
                    oModel.setProperty("/busy", false);
                    oComponent.getRouter().navTo("RouteApproval", { delivery: sDelivery });
                    return undefined;
                }
                // a delivery with saved entries is edited instead of entered again
                return rfHuInbound.readEntries(oComponent.getModel("rfhu"), sDelivery).then((aContexts) => {
                    oModel.setProperty("/busy", false);
                    if (!aContexts.length) {
                        oComponent.getRouter().navTo("RouteView2", { delivery: sDelivery });
                        return;
                    }
                    const sEdit = this._getText("edit");
                    MessageBox.confirm(this._getText("deliveryExists", [sDelivery]), {
                        actions: [sEdit, MessageBox.Action.CANCEL],
                        emphasizedAction: sEdit,
                        onClose: (sAction) => {
                            if (sAction === sEdit) {
                                oComponent.getRouter().navTo("RouteView2", { delivery: sDelivery });
                            } else {
                                this._focusDelivery();
                            }
                        }
                    });
                });
            }).catch((oError) => {
                oModel.setProperty("/busy", false);
                MessageBox.error(this._getText("backendError", [oError.status || "", oError.message || ""]));
                this._focusDelivery();
            });
        },

        _getText(sKey, aArgs) {
            return this.getView().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        }
    });
});
