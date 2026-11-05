/* global Promise */
sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ndc/BarcodeScanner",
    "com/ewm/zrfinbound/model/barcode",
    "com/ewm/zrfinbound/model/inboundDelivery",
    "com/ewm/zrfinbound/model/product",
    "com/ewm/zrfinbound/model/rfHuInbound",
    "sap/base/Log"
], (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, BarcodeScanner, barcode, inboundDelivery, product, rfHuInbound, Log) => {
    "use strict";

    const createItem = () => ({
        barcode: "",
        product: "",
        productState: "None",
        productStateText: "",
        deliveryItem: "",
        plant: "",
        unit: "",
        sled: "",
        batch: "",
        quantity: "",
        quantityState: "None",
        saving: false,
        serialNumbers: [],
        serialProfile: "",
        serialProfileBusy: false,
        hu: "",
        huSelected: false,
        packMaterial: ""
    });

    return Controller.extend("com.ewm.zrfinbound.controller.View2", {
        onInit() {
            this.getView().setModel(new JSONModel(Object.assign({ delivery: "" }, createItem())), "view");
            this.getView().setModel(new JSONModel({ items: [], busy: false }), "items");
            this.getView().setModel(new JSONModel({ items: [] }), "batches");

            // a delivery picked from a purchase order opens the same screen as a scanned one
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("RouteView2").attachPatternMatched(this._onRouteMatched, this);
            oRouter.getRoute("RouteDeliveryDetail").attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched(oEvent) {
            const oArgs = oEvent.getParameter("arguments");
            const sDelivery = oArgs.delivery;
            const oModel = this.getView().getModel("view");
            const oSerial = this.getOwnerComponent().getModel("serial");
            this._sPurchaseOrder = oArgs.purchaseOrder;

            // coming back from the serial number screen keeps what was entered here
            if (oSerial.getProperty("/returning") && oModel.getProperty("/delivery") === sDelivery) {
                oSerial.setProperty("/returning", false);
                if (oSerial.getProperty("/saved")) {
                    oModel.setProperty("/serialNumbers", oSerial.getProperty("/serialNumbers").slice());
                }
                this._focus("quantityInput");
                return;
            }
            oSerial.setProperty("/returning", false);
            oModel.setProperty("/delivery", sDelivery);
            this.onClear();
            this._loadItems(sDelivery);
        },

        _loadItems(sDelivery) {
            const oItems = this.getView().getModel("items");
            oItems.setData({ items: [], busy: true });

            // products scanned before the items arrive wait for them instead of counting as not in the delivery
            let fnLoaded;
            this._pItemsLoaded = new Promise((fnResolve) => {
                fnLoaded = fnResolve;
            });
            inboundDelivery.readByDelivery(this.getOwnerComponent().getModel(), sDelivery).then((aItems) => {
                oItems.setData({ items: aItems, busy: false });
            }, (oError) => {
                oItems.setProperty("/busy", false);
                MessageBox.error(this._getText("backendError", [oError.status || "", oError.message || ""]));
            }).finally(fnLoaded);
        },

        onItemPress(oEvent) {
            const oItem = oEvent.getSource().getBindingContext("items").getObject();
            this._startItem(oItem.Product);
            this.byId("itemPanel").setExpanded(false);
            this._fillFromDeliveryItem(oItem);
        },

        onProductChange() {
            this._startItem(this.getView().getModel("view").getProperty("/product"));
            this._showProduct();
        },

        // a scanned GTIN stands for the product it is maintained for
        _resolveProduct(sValue) {
            const sGtin = (sValue || "").trim();
            if (!barcode.isGtin(sGtin)) {
                return Promise.resolve(sValue);
            }
            return product.readByGtin(this.getOwnerComponent().getModel("gtin"), sGtin).then(
                (oGtin) => (oGtin ? oGtin.product : sValue), (oError) => {
                    // without the GTIN lookup the product number can still be scanned, so the user is not bothered
                    Log.warning("GTIN lookup failed", oError.message, "com.ewm.zrfinbound.controller.View2");
                    return sValue;
                });
        },

        // replaces a scanned GTIN by its product and fills the screen with the product's delivery item
        _showProduct() {
            const oModel = this.getView().getModel("view");
            const sScanned = oModel.getProperty("/product");
            this._resolveProduct(sScanned).then((sProduct) => {
                // ignore the answer when another product was scanned in the meantime
                if (oModel.getProperty("/product") !== sScanned) {
                    return undefined;
                }
                oModel.setProperty("/product", sProduct);
                return this._pItemsLoaded.then(() => this._fillFromDeliveryItem(this._findDeliveryItem()));
            });
        },

        // a newly picked product starts empty, so nothing of the previous product is left on the screen
        _startItem(sProduct) {
            const oModel = this.getView().getModel("view");
            oModel.setData(Object.assign({ delivery: oModel.getProperty("/delivery") }, createItem(), { product: sProduct }));
            this._bBatchScanned = false;
        },

        _findDeliveryItem() {
            const sProduct = (this.getView().getModel("view").getProperty("/product") || "").trim();
            return sProduct && this.getView().getModel("items").getProperty("/items")
                .find((oItem) => product.normalize(oItem.Product) === product.normalize(sProduct));
        },

        // fills the screen with the delivery item of the product and whether it needs serial numbers
        _fillFromDeliveryItem(oItem) {
            const oModel = this.getView().getModel("view");
            const sProduct = (oModel.getProperty("/product") || "").trim();

            // serial numbers are entered by hand for each product
            oModel.setProperty("/serialNumbers", []);
            this._oDeliveryItem = oItem || null;
            if (!sProduct) {
                return;
            }

            if (!oItem) {
                oModel.setProperty("/productState", "Warning");
                oModel.setProperty("/productStateText", this._getText("productNotInDelivery", [sProduct, oModel.getProperty("/delivery")]));
                oModel.setProperty("/deliveryItem", "");
                oModel.setProperty("/plant", "");
                oModel.setProperty("/unit", "");
                oModel.setProperty("/serialProfile", "");
                oModel.setProperty("/serialProfileBusy", false);
                this._focus("quantityInput");
                return;
            }
            oModel.setProperty("/product", oItem.Product);
            oModel.setProperty("/productState", "None");
            oModel.setProperty("/deliveryItem", oItem.InboundDeliveryItem);
            oModel.setProperty("/plant", oItem.Plant);
            oModel.setProperty("/quantity", String(oItem.ActualDeliveryQuantity));
            oModel.setProperty("/unit", oItem.DeliveryQuantityUnit);
            // a batch from the barcode wins over the one on the delivery item
            if (!oModel.getProperty("/batch") && oItem.Batch) {
                oModel.setProperty("/batch", oItem.Batch);
            }
            this._focus("quantityInput");
            this._loadSerialNumberProfile(oItem);
            this._loadSavedEntries(oItem);
        },

        // an item saved before shows its saved values, so editing the delivery starts from them
        _loadSavedEntries(oItem) {
            const oModel = this.getView().getModel("view");
            const bBatchScanned = this._bBatchScanned;

            rfHuInbound.readEntries(this.getOwnerComponent().getModel("rfhu"), oModel.getProperty("/delivery"),
                oItem.InboundDeliveryItem).then((aContexts) => {
                // ignore the answer when another product was scanned in the meantime
                if (!aContexts.length || oModel.getProperty("/deliveryItem") !== oItem.InboundDeliveryItem) {
                    return;
                }
                const aEntries = aContexts.map((oContext) => oContext.getObject());
                const oFirst = aEntries[0];
                oModel.setProperty("/quantity", String(aEntries.reduce((fSum, oEntry) => fSum + Number(oEntry.Quantity), 0)));
                // a product without serial number profile takes no serial numbers, even if some were saved before
                if (oModel.getProperty("/serialProfileBusy") || oModel.getProperty("/serialProfile")) {
                    oModel.setProperty("/serialNumbers", aEntries.map((oEntry) => oEntry.SerialNumber).filter(Boolean));
                }
                // a scanned barcode wins over the saved batch and SLED
                if (!bBatchScanned) {
                    oModel.setProperty("/batch", oFirst.Batch || oModel.getProperty("/batch"));
                }
                if (!oModel.getProperty("/sled")) {
                    oModel.setProperty("/sled", barcode.dateToSled(oFirst.ExpiryDate));
                }
                oModel.setProperty("/huSelected", oFirst.HuFlag === "X");
                oModel.setProperty("/hu", oFirst.HandlingUnit || "");
                oModel.setProperty("/packMaterial", oFirst.PackagingMaterial || "");
            }, (oError) => {
                MessageBox.error(this._getText("entriesReadError", [oError.message || ""]));
            });
        },

        // a product with a serial number profile needs one serial number per piece
        _loadSerialNumberProfile(oItem) {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/serialProfile", "");
            oModel.setProperty("/serialProfileBusy", true);

            product.readSerialNumberProfile(this.getOwnerComponent().getModel("serialisation"), oItem.Product,
                oItem.Plant).then((sProfile) => {
                // ignore the answer when another product was scanned in the meantime
                if (oModel.getProperty("/deliveryItem") !== oItem.InboundDeliveryItem) {
                    return;
                }
                oModel.setProperty("/serialProfileBusy", false);
                oModel.setProperty("/serialProfile", sProfile);
                // without a serial number profile the product takes no serial numbers
                if (!sProfile) {
                    oModel.setProperty("/serialNumbers", []);
                }
            }, (oError) => {
                if (oModel.getProperty("/deliveryItem") !== oItem.InboundDeliveryItem) {
                    return;
                }
                oModel.setProperty("/serialProfileBusy", false);
                MessageBox.error(this._getText("serialProfileReadError", [oError.message || ""]));
            });
        },

        formatSerialNumbers(aSerialNumbers) {
            const aValues = aSerialNumbers || [];
            return aValues.length > 1
                ? this._getText("serialNumbersSummary", [aValues[0], aValues.length - 1])
                : aValues[0] || "";
        },

        onSerialNumberPress() {
            const oModel = this.getView().getModel("view");
            const oData = oModel.getData();

            if (!(oData.product || "").trim()) {
                oModel.setProperty("/productState", "Error");
                this._focus("barcodeInput");
                return;
            }
            if (!oData.serialProfile) {
                MessageToast.show(this._getText("serialNumberNotAllowedError", [oData.product]));
                return;
            }
            this.getOwnerComponent().getModel("serial").setData({
                product: oData.product,
                quantity: Number(oData.quantity) || 0,
                unit: oData.unit,
                serialNumbers: oData.serialNumbers.slice(),
                returning: true,
                saved: false
            });
            this.getOwnerComponent().getRouter().navTo("RouteSerialNumbers");
        },

        // pack material and HU number only apply while the HU box is ticked
        onHuSelect(oEvent) {
            const oModel = this.getView().getModel("view");
            if (!oEvent.getParameter("selected")) {
                oModel.setProperty("/packMaterial", "");
                oModel.setProperty("/hu", "");
            }
        },

        // the batch value help lists the batches of the product in the plant of its delivery item
        onBatchValueHelp() {
            const oModel = this.getView().getModel("view");
            const sProduct = (oModel.getProperty("/product") || "").trim();
            const oBatches = this.getView().getModel("batches");

            if (!sProduct) {
                MessageToast.show(this._getText("batchProductRequired"));
                this._focus("barcodeInput");
                return;
            }
            if (!this._pBatchDialog) {
                this._pBatchDialog = this.loadFragment({ name: "com.ewm.zrfinbound.view.BatchValueHelp" });
            }
            oBatches.setProperty("/items", []);
            this._pBatchDialog.then((oDialog) => {
                oDialog.getBinding("items").filter([]);
                oDialog.setBusy(true);
                oDialog.open();
                return product.readBatches(this.getOwnerComponent().getModel("batch"), sProduct,
                    oModel.getProperty("/plant") || "").then((aBatches) => {
                    oBatches.setProperty("/items", aBatches.map((sBatch) => ({ batch: sBatch })));
                }, (oError) => {
                    MessageBox.error(this._getText("batchReadError", [oError.message || ""]));
                }).finally(() => oDialog.setBusy(false));
            });
        },

        onBatchSearch(oEvent) {
            const sValue = (oEvent.getParameter("value") || "").trim();
            oEvent.getParameter("itemsBinding").filter(sValue ? [new Filter("batch", FilterOperator.Contains, sValue)] : []);
        },

        onBatchConfirm(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            if (oItem) {
                this.getView().getModel("view").setProperty("/batch", oItem.getBindingContext("batches").getProperty("batch"));
            }
            this._focus("quantityInput");
        },

        onBatchCancel() {
            this._focus("batchInput");
        },

        _getText(sKey, aArgs) {
            return this.getView().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        _focus(sId) {
            // RF guns type into the focused field, so keep the cursor there
            setTimeout(() => this.byId(sId).focus(), 0);
        },

        onNavBack() {
            const oRouter = this.getOwnerComponent().getRouter();
            if (this._sPurchaseOrder) {
                oRouter.navTo("RoutePurchaseOrder", { purchaseOrder: this._sPurchaseOrder }, true);
            } else {
                oRouter.navTo("RouteView1", {}, true);
            }
        },

        // the scan icon in the barcode input opens the device camera
        onScanPress() {
            BarcodeScanner.scan((oResult) => {
                if (oResult.cancelled) {
                    return;
                }
                this.getView().getModel("view").setProperty("/barcode", oResult.text || "");
                this.onBarcodeSubmit();
            }, () => this.onScanFail(), undefined, this._getText("scanProduct"));
        },

        onScanFail() {
            MessageToast.show(this._getText("scanFailed"));
        },

        onBarcodeSubmit() {
            const oModel = this.getView().getModel("view");
            const sBarcode = (oModel.getProperty("/barcode") || "").trim();

            if (!sBarcode) {
                return;
            }
            const oResult = barcode.parse(sBarcode);
            oModel.setProperty("/product", oResult.product);
            oModel.setProperty("/sled", oResult.sled);
            oModel.setProperty("/batch", oResult.batch);
            oModel.setProperty("/barcode", "");
            this._bBatchScanned = !!oResult.batch;
            this._showProduct();
        },

        onClear() {
            const oModel = this.getView().getModel("view");
            oModel.setData(Object.assign({ delivery: oModel.getProperty("/delivery") }, createItem()));
            this._oDeliveryItem = null;
            this._focus("barcodeInput");
        },

        _checkSerialNumbers(oData) {
            if (oData.serialProfileBusy) {
                MessageToast.show(this._getText("serialProfileLoading"));
                return false;
            }
            if (!oData.serialProfile && oData.serialNumbers.length) {
                MessageBox.error(this._getText("serialNumberNotAllowedError", [oData.product]));
                return false;
            }
            // each serial number is stored as its own entry, so they have to cover the quantity exactly
            if ((oData.serialNumbers.length || oData.serialProfile)
                && oData.serialNumbers.length !== Number(oData.quantity)) {
                MessageBox.error(this._getText("serialNumberCountMismatch", [oData.serialNumbers.length, oData.quantity]));
                return false;
            }
            return true;
        },

        // stores the entered item in the custom table, the goods receipt is posted after approval
        onSave() {
            const oModel = this.getView().getModel("view");
            const oData = oModel.getData();
            const bProduct = !!(oData.product || "").trim();
            const bQuantity = Number(oData.quantity) > 0;

            oModel.setProperty("/productState", bProduct ? "None" : "Error");
            oModel.setProperty("/quantityState", bQuantity ? "None" : "Error");
            if (!bProduct || !bQuantity) {
                this._focus(bProduct ? "quantityInput" : "barcodeInput");
                return;
            }

            const oItem = this._oDeliveryItem;
            if (!oItem) {
                MessageBox.error(this._getText("productNotInDelivery", [oData.product, oData.delivery]));
                return;
            }
            if (!this._checkSerialNumbers(oData)) {
                return;
            }

            const oEntry = {
                InboundDelivery: rfHuInbound.deliveryNumber(oData.delivery),
                InboundDeliveryItem: rfHuInbound.itemNumber(oItem.InboundDeliveryItem),
                PurchaseDocument: oItem.ReferenceSDDocument || this._sPurchaseOrder || "",
                Product: oItem.Product,
                Batch: (oData.batch || "").trim(),
                QuantityUOM: oData.unit,
                ExpiryDate: barcode.sledToDate(oData.sled),
                HandlingUnit: oData.huSelected ? (oData.hu || "").trim() : "",
                PackagingMaterial: oData.huSelected ? (oData.packMaterial || "").trim() : "",
                HuFlag: oData.huSelected ? "X" : "",
                ReceivingComplete: ""
            };
            const aEntries = oData.serialNumbers.length
                ? oData.serialNumbers.map((sSerialNumber) => Object.assign({}, oEntry, { Quantity: "1", SerialNumber: sSerialNumber }))
                : [Object.assign({}, oEntry, { Quantity: String(oData.quantity), SerialNumber: "" })];

            // only the entries are created in the custom table; quantity and batch go to the EWM item when the goods receipt is posted
            oModel.setProperty("/saving", true);
            rfHuInbound.createEntries(this.getOwnerComponent().getModel("rfhu"), aEntries).then(() => {
                oModel.setProperty("/saving", false);
                MessageToast.show(this._getText("itemSaved", [oItem.Product, oData.delivery]));
                this.onClear();
            }, (oError) => {
                oModel.setProperty("/saving", false);
                MessageBox.error(this._getText("itemSaveError", [oError.message || ""]));
            });
        }
    });
});
