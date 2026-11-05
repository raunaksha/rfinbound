sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/routing/History",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/ndc/BarcodeScanner"
], (Controller, History, JSONModel, MessageToast, BarcodeScanner) => {
    "use strict";

    return Controller.extend("com.ewm.zrfinbound.controller.SerialNumber", {
        onInit() {
            this.getView().setModel(new JSONModel({ serialNumbers: [] }), "view");

            this.getOwnerComponent().getRouter().getRoute("RouteSerialNumbers")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        // the delivery screen hands over product, quantity and serial numbers in the component's serial model
        _onRouteMatched() {
            const oSerial = this.getOwnerComponent().getModel("serial");
            if (!oSerial.getProperty("/product")) {
                // opened by URL without a product, so there is nothing to capture
                this.getOwnerComponent().getRouter().navTo("RouteView1", {}, true);
                return;
            }
            this.getView().getModel("view").setData({
                product: oSerial.getProperty("/product"),
                quantity: oSerial.getProperty("/quantity"),
                unit: oSerial.getProperty("/unit"),
                serialNumbers: oSerial.getProperty("/serialNumbers").slice(),
                serialNumber: "",
                serialNumberState: "None",
                serialNumberStateText: ""
            });
            this._focus("snSerialNumberInput");
        },

        _getText(sKey, aArgs) {
            return this.getView().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        _focus(sId) {
            // RF guns type into the focused field, so keep the cursor there
            setTimeout(() => this.byId(sId).focus(), 0);
        },

        _setError(sText) {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/serialNumberState", "Error");
            oModel.setProperty("/serialNumberStateText", sText);
            this._focus("snSerialNumberInput");
        },

        // the scan icon in the serial number input opens the device camera
        onScanPress() {
            BarcodeScanner.scan((oResult) => {
                if (oResult.cancelled) {
                    return;
                }
                this.getView().getModel("view").setProperty("/serialNumber", oResult.text || "");
                this.onSerialNumberSubmit();
            }, () => this.onScanFail(), undefined, this._getText("serialNumber"));
        },

        onScanFail() {
            MessageToast.show(this._getText("scanFailed"));
        },

        onSerialNumberSubmit() {
            const oModel = this.getView().getModel("view");
            const sSerialNumber = (oModel.getProperty("/serialNumber") || "").trim();
            const aSerialNumbers = oModel.getProperty("/serialNumbers");

            if (!sSerialNumber) {
                return;
            }
            if (aSerialNumbers.includes(sSerialNumber)) {
                this._setError(this._getText("serialNumberDuplicate", [sSerialNumber]));
                return;
            }
            // the quantity limits the serial numbers only when one was entered on the delivery screen
            const iQuantity = Number(oModel.getProperty("/quantity")) || 0;
            if (iQuantity > 0 && aSerialNumbers.length >= iQuantity) {
                this._setError(this._getText("serialNumbersComplete", [oModel.getProperty("/quantity")]));
                return;
            }
            oModel.setProperty("/serialNumbers", aSerialNumbers.concat(sSerialNumber));
            oModel.setProperty("/serialNumber", "");
            oModel.setProperty("/serialNumberState", "None");
            this._focus("snSerialNumberInput");
        },

        // deletes the serial number in the input when it was entered, otherwise the last one entered
        onDelete() {
            const oModel = this.getView().getModel("view");
            const sSerialNumber = (oModel.getProperty("/serialNumber") || "").trim();
            const aSerialNumbers = oModel.getProperty("/serialNumbers").slice();

            if (!aSerialNumbers.length) {
                MessageToast.show(this._getText("noSerialNumbers"));
                return;
            }
            const iIndex = aSerialNumbers.indexOf(sSerialNumber);
            const sDeleted = aSerialNumbers.splice(iIndex >= 0 ? iIndex : aSerialNumbers.length - 1, 1)[0];
            oModel.setProperty("/serialNumbers", aSerialNumbers);
            oModel.setProperty("/serialNumber", "");
            oModel.setProperty("/serialNumberState", "None");
            MessageToast.show(this._getText("serialNumberDeleted", [sDeleted]));
            this._focus("snSerialNumberInput");
        },

        onList() {
            if (!this._pListDialog) {
                this._pListDialog = this.loadFragment({ name: "com.ewm.zrfinbound.view.SerialNumberList" });
            }
            this._pListDialog.then((oDialog) => oDialog.open());
        },

        onListDelete(oEvent) {
            const oModel = this.getView().getModel("view");
            const sDeleted = oEvent.getParameter("listItem").getBindingContext("view").getObject();
            oModel.setProperty("/serialNumbers", oModel.getProperty("/serialNumbers").filter((s) => s !== sDeleted));
        },

        onListClose() {
            this.byId("serialNumberListDialog").close();
            this._focus("snSerialNumberInput");
        },

        onSave() {
            // a serial number typed but not yet confirmed with Enter still counts
            this.onSerialNumberSubmit();
            // it stays in the input only when it was refused, e.g. as a duplicate
            if ((this.getView().getModel("view").getProperty("/serialNumber") || "").trim()) {
                return;
            }
            const oSerial = this.getOwnerComponent().getModel("serial");
            oSerial.setProperty("/serialNumbers", this.getView().getModel("view").getProperty("/serialNumbers").slice());
            oSerial.setProperty("/saved", true);
            this.onNavBack();
        },

        // returns to the delivery screen it came from, the serial numbers are only kept after save
        onNavBack() {
            if (History.getInstance().getPreviousHash() !== undefined) {
                window.history.go(-1);
            } else {
                this.getOwnerComponent().getRouter().navTo("RouteView1", {}, true);
            }
        }
    });
});
