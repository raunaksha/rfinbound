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
    "com/ewm/zrfinbound/model/ewmOperations",
    "sap/base/Log"
], (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, BarcodeScanner, barcode, inboundDelivery, product, rfHuInbound,
    ewmOperations, Log) => {
    "use strict";

    // pack material proposed when the HU box is ticked
    const DEFAULT_PACK_MATERIAL = "PALLET";

    // quantities are received in whole pieces, so decimals from the backend (e.g. 5.000) are shown as 5
    const toInteger = (vValue) => {
        const fValue = Number(vValue);
        return vValue === "" || vValue === null || vValue === undefined || !isFinite(fValue)
            ? "" : String(Math.round(fValue));
    };

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
        batchState: "None",
        batchStateText: "",
        grDocument: "",
        quantity: "",
        quantityState: "None",
        saving: false,
        serialNumbers: [],
        serialProfile: "",
        serialProfileBusy: false,
        hu: "",
        huSelected: false,
        packMaterial: DEFAULT_PACK_MATERIAL
    });

    return Controller.extend("com.ewm.zrfinbound.controller.View2", {
        onInit() {
            this.getView().setModel(new JSONModel(Object.assign({ delivery: "" }, createItem())), "view");
            this.getView().setModel(new JSONModel({ items: [], busy: false }), "items");
            this.getView().setModel(new JSONModel({ items: [] }), "batches");
            this.getView().setModel(new JSONModel({}), "newBatch");

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
            oItems.setData({ items: [], busy: true, nonSerialised: false });
            this._mSerialProfiles = {};

            // products scanned before the items arrive wait for them instead of counting as not in the delivery
            let fnLoaded;
            this._pItemsLoaded = new Promise((fnResolve) => {
                fnLoaded = fnResolve;
            });
            inboundDelivery.readByDelivery(this.getOwnerComponent().getModel(), sDelivery).then((aItems) => {
                oItems.setData({ items: aItems, busy: false, nonSerialised: false });
                this._checkDeliverySerialised(sDelivery, aItems);
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
            this._oBatches = null;
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
            oModel.setProperty("/quantity", toInteger(oItem.ActualDeliveryQuantity));
            oModel.setProperty("/unit", oItem.DeliveryQuantityUnit);
            // a batch from the barcode wins over the one on the delivery item
            if (!oModel.getProperty("/batch") && oItem.Batch) {
                oModel.setProperty("/batch", oItem.Batch);
            }
            this._focus("quantityInput");
            this._checkGrPosted(oItem);
            this._loadSerialNumberProfile(oItem);
            this._loadSavedEntries(oItem);
        },

        // an item with a posted goods receipt cannot be received again
        _readGrDocument(oItem) {
            const oModel = this.getView().getModel("view");
            return inboundDelivery.readGrDocument(this.getOwnerComponent().getModel(),
                rfHuInbound.deliveryNumber(oModel.getProperty("/delivery")), rfHuInbound.itemNumber(oItem.InboundDeliveryItem));
        },

        _showGrPosted(oItem, sGrDocument) {
            const oModel = this.getView().getModel("view");
            MessageBox.error(this._getText("grAlreadyPosted", [oModel.getProperty("/delivery"),
                rfHuInbound.itemNumber(oItem.InboundDeliveryItem), sGrDocument]), {
                onClose: () => this.onClear()
            });
        },

        _checkGrPosted(oItem) {
            const oModel = this.getView().getModel("view");
            this._readGrDocument(oItem).then((sGrDocument) => {
                // ignore the answer when another product was scanned in the meantime
                if (!sGrDocument || oModel.getProperty("/deliveryItem") !== oItem.InboundDeliveryItem) {
                    return;
                }
                oModel.setProperty("/grDocument", sGrDocument);
                this._showGrPosted(oItem, sGrDocument);
            }, (oError) => {
                // the check is repeated on save, so a failed read only gets logged here
                Log.warning("Goods receipt check failed", oError.message, "com.ewm.zrfinbound.controller.View2");
            });
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
                oModel.setProperty("/quantity", toInteger(aEntries.reduce((fSum, oEntry) => fSum + Number(oEntry.Quantity), 0)));
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
                oModel.setProperty("/packMaterial", oFirst.PackagingMaterial || DEFAULT_PACK_MATERIAL);
            }, (oError) => {
                MessageBox.error(this._getText("entriesReadError", [oError.message || ""]));
            });
        },

        // the profile is read once per product and plant, for the delivery check and the selected item
        _readSerialProfile(oItem) {
            const sKey = oItem.Product + "|" + (oItem.Plant || "");
            this._mSerialProfiles = this._mSerialProfiles || {};
            if (!this._mSerialProfiles[sKey]) {
                const pProfile = product.readSerialNumberProfile(this.getOwnerComponent().getModel("serialisation"),
                    oItem.Product, oItem.Plant);
                // a failed read is tried again next time
                pProfile.catch(() => {
                    if (this._mSerialProfiles[sKey] === pProfile) {
                        delete this._mSerialProfiles[sKey];
                    }
                });
                this._mSerialProfiles[sKey] = pProfile;
            }
            return this._mSerialProfiles[sKey];
        },

        // a delivery none of whose items has a serial number profile says so before any item is picked
        _checkDeliverySerialised(sDelivery, aItems) {
            const oItems = this.getView().getModel("items");
            if (!aItems.length) {
                return;
            }
            Promise.all(aItems.map((oItem) => this._readSerialProfile(oItem))).then((aProfiles) => {
                // ignore the answer when another delivery was opened in the meantime
                if (this.getView().getModel("view").getProperty("/delivery") === sDelivery) {
                    oItems.setProperty("/nonSerialised", aProfiles.every((sProfile) => !sProfile));
                }
            }, (oError) => {
                // the selected item is checked on its own, so a failed check only gets logged here
                Log.warning("Serial number profile check failed", oError.message, "com.ewm.zrfinbound.controller.View2");
            });
        },

        // a product with a serial number profile needs one serial number per piece
        _loadSerialNumberProfile(oItem) {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/serialProfile", "");
            oModel.setProperty("/serialProfileBusy", true);

            this._readSerialProfile(oItem).then((sProfile) => {
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

        // the serial number box says so when the selected item, or before any item is picked the whole
        // delivery, has no serial number profile
        isNonSerialised(sSerialProfile, bSerialProfileBusy, sDeliveryItem, bDeliveryNonSerialised) {
            return sDeliveryItem ? !sSerialProfile && !bSerialProfileBusy : !!bDeliveryNonSerialised;
        },

        formatSerialNumberState(sSerialProfile, bSerialProfileBusy, sDeliveryItem, bDeliveryNonSerialised) {
            return this.isNonSerialised(sSerialProfile, bSerialProfileBusy, sDeliveryItem, bDeliveryNonSerialised)
                ? "Information" : "None";
        },

        formatSerialNumbers(aSerialNumbers, sSerialProfile, bSerialProfileBusy, sDeliveryItem, bDeliveryNonSerialised) {
            if (this.isNonSerialised(sSerialProfile, bSerialProfileBusy, sDeliveryItem, bDeliveryNonSerialised)) {
                return this._getText(sDeliveryItem ? "serialNumberNotAllowed" : "deliveryNonSerialised");
            }
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
            this._blurActive();
            this.getOwnerComponent().getRouter().navTo("RouteSerialNumbers");
        },

        // pack material and HU number only apply while the HU box is ticked
        onHuSelect(oEvent) {
            const oModel = this.getView().getModel("view");
            if (!oEvent.getParameter("selected")) {
                oModel.setProperty("/packMaterial", "");
                oModel.setProperty("/hu", "");
            } else if (!oModel.getProperty("/packMaterial")) {
                oModel.setProperty("/packMaterial", DEFAULT_PACK_MATERIAL);
            }
        },

        // quantities are whole pieces, so decimal separators and exponents are dropped while typing
        onQuantityLiveChange(oEvent) {
            const sValue = oEvent.getParameter("value") || "";
            if (/[^0-9]/.test(sValue)) {
                const sInteger = sValue.replace(/[.,].*$/, "").replace(/[^0-9]/g, "");
                oEvent.getSource().setValue(sInteger);
                this.getView().getModel("view").setProperty("/quantity", sInteger);
            }
        },

        formatQuantityUnit(vQuantity, sUnit) {
            return (toInteger(vQuantity) + " " + (sUnit || "")).trim();
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
                return this._readBatches(sProduct, oModel.getProperty("/plant") || "").then((aBatches) => {
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
                const oModel = this.getView().getModel("view");
                oModel.setProperty("/batch", oItem.getBindingContext("batches").getProperty("batch"));
                oModel.setProperty("/batchState", "None");
            }
            this._focus("quantityInput");
        },

        onBatchCancel() {
            this._focus("batchInput");
        },

        // the batches are read once per product and plant, for the value help and the check on save
        _readBatches(sProduct, sPlant) {
            const sKey = sProduct + "|" + sPlant;
            if (!this._oBatches || this._oBatches.key !== sKey) {
                const oBatches = {
                    key: sKey,
                    promise: product.readBatches(this.getOwnerComponent().getModel("batch"), sProduct, sPlant)
                };
                // a failed read is tried again next time
                oBatches.promise.catch(() => {
                    if (this._oBatches === oBatches) {
                        this._oBatches = null;
                    }
                });
                this._oBatches = oBatches;
            }
            // batches created in this session count as well, as the read may not return them (yet), e.g. because
            // they are created at material level and the read is per plant
            return this._oBatches.promise.then((aBatches) => {
                const aCreated = this._getCreatedBatches(sProduct);
                return aBatches.concat(aCreated.filter((sBatch) => !aBatches.includes(sBatch)));
            });
        },

        _getCreatedBatches(sProduct) {
            this._mCreatedBatches = this._mCreatedBatches || {};
            return this._mCreatedBatches[product.normalize(sProduct)] || [];
        },

        _rememberCreatedBatch(sProduct, sBatch) {
            const aCreated = this._getCreatedBatches(sProduct);
            if (!aCreated.includes(sBatch)) {
                this._mCreatedBatches[product.normalize(sProduct)] = aCreated.concat(sBatch);
            }
        },

        // the batch has to be one of the value help, also when it was scanned or taken from the delivery item;
        // a product with batches cannot be saved without one
        _checkBatch(oData, oItem) {
            const oModel = this.getView().getModel("view");
            const sBatch = (oData.batch || "").trim();

            return this._readBatches(oItem.Product, oItem.Plant || "").then((aBatches) => {
                // a scanned batch that does not exist yet can be created right away, the save then goes on
                if (sBatch && !aBatches.includes(sBatch) && !aBatches.includes(sBatch.toUpperCase())) {
                    return this._askCreateBatch(sBatch, oItem);
                }
                let sError = "";
                if (!sBatch && aBatches.length) {
                    sError = this._getText("batchRequired", [oItem.Product]);
                }
                oModel.setProperty("/batchState", sError ? "Error" : "None");
                oModel.setProperty("/batchStateText", sError);
                if (sError) {
                    MessageBox.error(sError);
                }
                return !sError;
            }, (oError) => {
                MessageBox.error(this._getText("batchReadError", [oError.message || ""]));
                return false;
            });
        },

        _askCreateBatch(sBatch, oItem) {
            const oModel = this.getView().getModel("view");
            const sCreate = this._getText("createBatch");
            return new Promise((fnResolve) => {
                MessageBox.confirm(this._getText("batchNotFoundCreate", [sBatch, oItem.Product]), {
                    actions: [sCreate, MessageBox.Action.CANCEL],
                    emphasizedAction: sCreate,
                    onClose: (sAction) => {
                        if (sAction !== sCreate) {
                            oModel.setProperty("/batchState", "Error");
                            oModel.setProperty("/batchStateText", this._getText("batchInvalid", [sBatch, oItem.Product]));
                            fnResolve(false);
                            return;
                        }
                        this._openCreateBatch(oItem, sBatch).then(fnResolve);
                    }
                });
            });
        },

        // the Create Batch button creates a new batch for the selected delivery item
        onCreateBatchPress() {
            const oItem = this._oDeliveryItem;
            if (!oItem) {
                MessageToast.show(this._getText("batchProductRequired"));
                this._focus("barcodeInput");
                return;
            }
            this._openCreateBatch(oItem, (this.getView().getModel("view").getProperty("/batch") || "").trim());
        },

        // opens the Create Batch dialog; the promise resolves with whether a batch was created
        _openCreateBatch(oItem, sBatch) {
            const oView = this.getView();
            oView.getModel("newBatch").setData({
                product: oItem.Product,
                plant: oItem.Plant || "",
                batch: sBatch || "",
                sled: oView.getModel("view").getProperty("/sled") || "",
                batchState: "None",
                sledState: "None",
                busy: false
            });
            if (!this._pCreateBatchDialog) {
                this._pCreateBatchDialog = this.loadFragment({ name: "com.ewm.zrfinbound.view.CreateBatch" });
            }
            return new Promise((fnResolve) => {
                this._fnCreateBatchResolve = fnResolve;
                this._bBatchCreated = false;
                this._pCreateBatchDialog.then((oDialog) => {
                    oDialog.open();
                    this._focus(sBatch ? "createBatchSledInput" : "createBatchBatchInput");
                });
            });
        },

        onCreateBatchConfirm() {
            const oNewBatch = this.getView().getModel("newBatch");
            const oData = oNewBatch.getData();
            if (oData.busy) {
                return;
            }
            const sBatch = (oData.batch || "").trim().toUpperCase();
            const sSled = (oData.sled || "").trim();
            const sDate = sSled ? barcode.sledToDate(sSled) : "";

            oNewBatch.setProperty("/batchState", sBatch ? "None" : "Error");
            oNewBatch.setProperty("/sledState", sDate === null ? "Error" : "None");
            if (!sBatch || sDate === null) {
                this._focus(sBatch ? "createBatchSledInput" : "createBatchBatchInput");
                return;
            }

            oNewBatch.setProperty("/busy", true);
            // the batch is created at material level, so the plant is passed empty
            let sExists = "";
            ewmOperations.createBatch(this.getOwnerComponent(), oData.product, "", sBatch, sDate).catch((oError) => {
                // a batch that exists already (e.g. created before but not returned by the batch read) can be used
                if (/exist/i.test(oError.message || "")) {
                    sExists = oError.message;
                    return undefined;
                }
                throw oError;
            }).then(() => {
                const oModel = this.getView().getModel("view");
                // the new batch is valid from now on, also when the batches are read again
                this._rememberCreatedBatch(oData.product, sBatch);
                oModel.setProperty("/batch", sBatch);
                oModel.setProperty("/batchState", "None");
                oModel.setProperty("/batchStateText", "");
                if (sSled) {
                    oModel.setProperty("/sled", sSled);
                }
                this._bBatchCreated = true;
                if (sExists) {
                    MessageBox.information(this._getText("batchExistsUsed", [sExists]));
                } else {
                    MessageToast.show(this._getText("batchCreated", [sBatch, oData.product]));
                }
                this.byId("createBatchDialog").close();
            }, (oError) => {
                MessageBox.error(this._getText("batchCreateError", [sBatch, oError.message || ""]));
            }).finally(() => oNewBatch.setProperty("/busy", false));
        },

        onCreateBatchCancel() {
            this.byId("createBatchDialog").close();
        },

        onCreateBatchAfterClose() {
            if (this._fnCreateBatchResolve) {
                this._fnCreateBatchResolve(this._bBatchCreated);
                this._fnCreateBatchResolve = null;
            }
            this._focus(this._bBatchCreated ? "quantityInput" : "batchInput");
        },

        _getText(sKey, aArgs) {
            return this.getView().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        _focus(sId) {
            // RF guns type into the focused field, so keep the cursor there
            setTimeout(() => {
                // Don't pull focus back into this view once we've navigated away
                const oDomRef = this.getView().getDomRef();
                if (oDomRef && !oDomRef.closest("[aria-hidden='true']")) {
                    this.byId(sId).focus();
                }
            }, 0);
        },

        _blurActive() {
            // Release focus before the view is hidden, otherwise the browser
            // blocks aria-hidden on the outgoing page (focus retained warning)
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        },

        onNavBack() {
            this._blurActive();
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
            const bQuantity = Number.isInteger(Number(oData.quantity)) && Number(oData.quantity) > 0;

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

            oModel.setProperty("/saving", true);
            this._readGrDocument(oItem).then((sGrDocument) => {
                if (sGrDocument) {
                    oModel.setProperty("/grDocument", sGrDocument);
                    this._showGrPosted(oItem, sGrDocument);
                    return false;
                }
                return this._checkBatch(oData, oItem);
            }, (oError) => {
                MessageBox.error(this._getText("grCheckError", [oError.message || ""]));
                return false;
            }).then((bValid) => {
                if (bValid) {
                    this._saveEntries(oData, oItem);
                } else {
                    oModel.setProperty("/saving", false);
                }
            });
        },

        // serial numbers saved before for the item are either replaced by the new ones or kept and added to;
        // only the new serial numbers are created, so the ones saved before are not stored twice
        _saveEntries(oData, oItem) {
            const oModel = this.getView().getModel("view");
            if (!oData.serialNumbers.length) {
                this._createEntries(oData, oItem, []);
                return;
            }
            rfHuInbound.readEntries(this.getOwnerComponent().getModel("rfhu"), oData.delivery, oItem.InboundDeliveryItem)
                .then((aContexts) => {
                    const aSaved = aContexts.filter((oContext) => oContext.getProperty("SerialNumber"));
                    const aSavedNumbers = aSaved.map((oContext) => oContext.getProperty("SerialNumber"));
                    const aNew = oData.serialNumbers.filter((sSerialNumber) => !aSavedNumbers.includes(sSerialNumber));
                    // posted entries cannot be rejected any more
                    const aDeletable = aSaved.filter((oContext) =>
                        !String(oContext.getProperty("GoodsReceiptNo") || "").trim().replace(/^0+/, ""));

                    if (!aSaved.length) {
                        this._createEntries(oData, oItem, aNew);
                        return;
                    }
                    if (!aNew.length) {
                        oModel.setProperty("/saving", false);
                        MessageToast.show(this._getText("noNewSerialNumbers"));
                        return;
                    }
                    const sDelete = this._getText("serialNumbersDeletePrevious");
                    const sAdd = this._getText("serialNumbersAddToExisting");
                    MessageBox.confirm(this._getText("serialNumbersPreviousQuestion",
                        [aNew.length, aSaved.length, oItem.Product]), {
                        title: this._getText("serialNumbersPreviousTitle"),
                        actions: [sDelete, sAdd, MessageBox.Action.CANCEL],
                        emphasizedAction: sAdd,
                        onClose: (sAction) => {
                            if (sAction === sAdd) {
                                this._createEntries(oData, oItem, aNew);
                            } else if (sAction === sDelete) {
                                this._createEntries(oData, oItem, aNew, aDeletable);
                            } else {
                                oModel.setProperty("/saving", false);
                            }
                        }
                    });
                }, (oError) => {
                    oModel.setProperty("/saving", false);
                    MessageBox.error(this._getText("entriesReadError", [oError.message || ""]));
                });
        },

        // aReplaced are the entries saved before, which are rejected (deleted) once the new ones are stored
        _createEntries(oData, oItem, aSerialNumbers, aReplaced) {
            const oModel = this.getView().getModel("view");
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
            const aEntries = aSerialNumbers.length
                ? aSerialNumbers.map((sSerialNumber) => Object.assign({}, oEntry, { Quantity: "1", SerialNumber: sSerialNumber }))
                : [Object.assign({}, oEntry, { Quantity: toInteger(oData.quantity), SerialNumber: "" })];

            // only the entries are created in the custom table; quantity and batch go to the EWM item when the goods receipt is posted
            rfHuInbound.createEntries(this.getOwnerComponent().getModel("rfhu"), aEntries).then(() => {
                // the previous entries are deleted only after the new ones are stored, so nothing is lost on a failed save
                if (!(aReplaced && aReplaced.length)) {
                    MessageToast.show(this._getText("itemSaved", [oItem.Product, oData.delivery]));
                    return undefined;
                }
                return rfHuInbound.deleteEntries(aReplaced).then(() => {
                    MessageToast.show(this._getText("serialNumbersReplaced", [aReplaced.length, oItem.Product]));
                }, (oError) => {
                    MessageBox.error(this._getText("serialNumbersReplaceError", [oError.message || ""]));
                });
            }).then(() => {
                oModel.setProperty("/saving", false);
                this.onClear();
            }, (oError) => {
                oModel.setProperty("/saving", false);
                MessageBox.error(this._getText("itemSaveError", [oError.message || ""]));
            });
        }
    });
});
