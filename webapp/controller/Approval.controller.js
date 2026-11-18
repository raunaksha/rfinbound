/* global Promise */
sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/format/DateFormat",
    "com/ewm/zrfinbound/model/rfHuInbound",
    "com/ewm/zrfinbound/model/ewmOperations"
], (Controller, JSONModel, MessageToast, MessageBox, DateFormat, rfHuInbound, ewmOperations) => {
    "use strict";

    return Controller.extend("com.ewm.zrfinbound.controller.Approval", {
        onInit() {
            this.getView().setModel(new JSONModel({
                delivery: "",
                entries: [],
                busy: false,
                posting: false,
                posted: false,
                canPost: false,
                selected: 0
            }), "view");
            this.getView().setModel(new JSONModel({ steps: [], running: false }), "progress");
            this._aContexts = [];

            this.getOwnerComponent().getRouter().getRoute("RouteApproval")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched(oEvent) {
            this.getView().getModel("view").setProperty("/delivery", oEvent.getParameter("arguments").delivery);
            this._loadEntries();
        },

        // the list shows plain copies of the entries; changes go through the contexts at the same index
        _loadEntries() {
            const oModel = this.getView().getModel("view");
            this._aContexts = [];
            this.byId("entryTable").removeSelections(true);
            oModel.setProperty("/selected", 0);
            oModel.setProperty("/entries", []);
            oModel.setProperty("/posted", false);
            oModel.setProperty("/busy", true);
            this._updateCanPost();

            rfHuInbound.readEntries(this.getOwnerComponent().getModel("rfhu"), oModel.getProperty("/delivery"))
                .then((aContexts) => {
                    this._aContexts = aContexts;
                    oModel.setProperty("/entries", aContexts.map((oContext) => Object.assign({}, oContext.getObject())));
                    oModel.setProperty("/busy", false);
                    this._updateCanPost();
                }, (oError) => {
                    oModel.setProperty("/busy", false);
                    MessageBox.error(this._getText("entriesReadError", [oError.message || ""]));
                });
        },

        // indexes of the entries that are confirmed but not posted yet
        _getConfirmedIndexes() {
            const aIndexes = [];
            this.getView().getModel("view").getProperty("/entries").forEach((oEntry, iIndex) => {
                if (oEntry.ReceivingComplete === "X" && !this.formatPosted(oEntry.GoodsReceiptDoneBy, oEntry.GoodsReceiptNo)) {
                    aIndexes.push(iIndex);
                }
            });
            return aIndexes;
        },

        // the goods receipt can be posted once every entry that is not posted yet is confirmed
        _updateCanPost() {
            const oModel = this.getView().getModel("view");
            const aOpen = oModel.getProperty("/entries")
                .filter((oEntry) => !this.formatPosted(oEntry.GoodsReceiptDoneBy, oEntry.GoodsReceiptNo));
            oModel.setProperty("/canPost", !oModel.getProperty("/posted") && aOpen.length > 0
                && aOpen.every((oEntry) => oEntry.ReceivingComplete === "X"));
        },

        // only the goods receipt number tells a posted entry, as the backend fills GoodsReceiptDoneBy on create already;
        // it sends blanks or zeros (e.g. 0000000000) for entries that are not posted yet
        formatPosted(sGoodsReceiptDoneBy, sGoodsReceiptNo) {
            return !!String(sGoodsReceiptNo || "").trim().replace(/^0+/, "");
        },

        // quantities are whole pieces, so decimals from the backend (e.g. 1.000) are shown as 1
        formatQuantity(vQuantity) {
            const fQuantity = Number(vQuantity);
            return vQuantity === "" || vQuantity === null || vQuantity === undefined || !isFinite(fQuantity)
                ? "" : String(Math.round(fQuantity));
        },

        formatStatusText(sReceivingComplete, sGoodsReceiptDoneBy, sGoodsReceiptNo) {
            if (this.formatPosted(sGoodsReceiptDoneBy, sGoodsReceiptNo)) {
                return this._getText("posted");
            }
            return this._getText(sReceivingComplete === "X" ? "confirmed" : "open");
        },

        formatStatusState(sReceivingComplete, sGoodsReceiptDoneBy, sGoodsReceiptNo) {
            if (this.formatPosted(sGoodsReceiptDoneBy, sGoodsReceiptNo)) {
                return "Success";
            }
            return sReceivingComplete === "X" ? "Information" : "None";
        },

        // the backend sends dates as yyyy-MM-dd and timestamps as ISO strings
        formatDate(sDate) {
            if (!sDate) {
                return "";
            }
            const oDate = DateFormat.getDateInstance({ pattern: "yyyy-MM-dd", UTC: true }).parse(sDate);
            return oDate ? DateFormat.getDateInstance({ style: "medium", UTC: true }).format(oDate) : sDate;
        },

        formatDateTime(sTimestamp) {
            const oDate = sTimestamp && new Date(sTimestamp);
            return oDate && !isNaN(oDate) ? DateFormat.getDateTimeInstance({ style: "medium" }).format(oDate) : (sTimestamp || "");
        },

        // writes the changed fields of the entries at the given indexes and copies them to the list
        _updateEntries(aIndexes, mValues) {
            const oModel = this.getView().getModel("view");
            return Promise.all(aIndexes.map((iIndex) => rfHuInbound.updateEntry(this._aContexts[iIndex], mValues)
                .then(() => {
                    oModel.setProperty("/entries/" + iIndex, Object.assign({}, this._aContexts[iIndex].getObject()));
                })));
        },

        _confirm(aIndexes, bConfirmed) {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/busy", true);

            return rfHuInbound.getUserId().then((sUser) => {
                const mValues = { ReceivingComplete: bConfirmed ? "X" : "" };
                if (sUser) {
                    mValues.ReceivingConfirmationBy = bConfirmed ? sUser : "";
                }
                return this._updateEntries(aIndexes, mValues);
            }).then(() => {
                oModel.setProperty("/busy", false);
                this._updateCanPost();
            }, (oError) => {
                oModel.setProperty("/busy", false);
                this._updateCanPost();
                MessageBox.error(this._getText("confirmError", [oError.message || ""]));
            });
        },

        onSelectionChange(oEvent) {
            this.getView().getModel("view").setProperty("/selected", oEvent.getSource().getSelectedItems().length);
        },

        // confirms the selected entries that are not confirmed or posted yet
        onConfirm() {
            const oTable = this.byId("entryTable");
            const oModel = this.getView().getModel("view");
            const aIndexes = oTable.getSelectedItems()
                .map((oItem) => Number(oItem.getBindingContext("view").getPath().split("/").pop()))
                .filter((iIndex) => {
                    const oEntry = oModel.getProperty("/entries/" + iIndex);
                    return oEntry.ReceivingComplete !== "X" && !this.formatPosted(oEntry.GoodsReceiptDoneBy, oEntry.GoodsReceiptNo);
                });
            oTable.removeSelections(true);
            oModel.setProperty("/selected", 0);
            if (!aIndexes.length) {
                MessageToast.show(this._getText("selectionConfirmed"));
                return;
            }
            this._confirm(aIndexes, true);
        },

        // rejected entries are deleted, so the item can be received again on the delivery screen
        onReject() {
            const oTable = this.byId("entryTable");
            const oModel = this.getView().getModel("view");
            const aIndexes = oTable.getSelectedItems()
                .map((oItem) => Number(oItem.getBindingContext("view").getPath().split("/").pop()))
                .filter((iIndex) => {
                    const oEntry = oModel.getProperty("/entries/" + iIndex);
                    return !this.formatPosted(oEntry.GoodsReceiptDoneBy, oEntry.GoodsReceiptNo);
                });
            if (!aIndexes.length) {
                MessageToast.show(this._getText("selectionPosted"));
                return;
            }
            const sReject = this._getText("reject");
            MessageBox.confirm(this._getText("rejectConfirm", [aIndexes.length]), {
                actions: [sReject, MessageBox.Action.CANCEL],
                emphasizedAction: sReject,
                onClose: (sAction) => {
                    if (sAction !== sReject) {
                        return;
                    }
                    oModel.setProperty("/busy", true);
                    rfHuInbound.deleteEntries(aIndexes.map((iIndex) => this._aContexts[iIndex])).then(() => {
                        MessageToast.show(this._getText("entriesRejected", [aIndexes.length]));
                    }, (oError) => {
                        MessageBox.error(this._getText("rejectError", [oError.message || ""]));
                    }).finally(() => this._loadEntries());
                }
            });
        },

        onConfirmAll() {
            const aIndexes = [];
            this.getView().getModel("view").getProperty("/entries").forEach((oEntry, iIndex) => {
                if (oEntry.ReceivingComplete !== "X" && !this.formatPosted(oEntry.GoodsReceiptDoneBy, oEntry.GoodsReceiptNo)) {
                    aIndexes.push(iIndex);
                }
            });
            if (!aIndexes.length) {
                MessageToast.show(this._getText("allConfirmed"));
                return;
            }
            this.byId("entryTable").removeSelections(true);
            this.getView().getModel("view").setProperty("/selected", 0);
            this._confirm(aIndexes, true);
        },

        // sums the confirmed entries up per delivery item, as the warehouse item takes one batch and quantity
        _groupByItem(aEntries) {
            const mItems = {};
            aEntries.forEach((oEntry) => {
                const oItem = mItems[oEntry.InboundDeliveryItem] || (mItems[oEntry.InboundDeliveryItem] = {
                    item: oEntry.InboundDeliveryItem,
                    batch: "",
                    quantity: 0,
                    unit: oEntry.QuantityUOM,
                    serialNumbers: []
                });
                oItem.batch = oItem.batch || oEntry.Batch || "";
                oItem.quantity += Number(oEntry.Quantity) || 0;
                if (oEntry.SerialNumber) {
                    oItem.serialNumbers.push(oEntry.SerialNumber);
                }
            });
            return Object.values(mItems);
        },

        onPostGR() {
            const oModel = this.getView().getModel("view");
            const sDelivery = oModel.getProperty("/delivery");

            this._updateCanPost();
            if (!oModel.getProperty("/canPost")) {
                MessageBox.error(this._getText("notAllConfirmed"));
                return;
            }
            // only the confirmed entries are written to the warehouse items and marked as posted
            const aIndexes = this._getConfirmedIndexes();
            const aEntries = aIndexes.map((iIndex) => oModel.getProperty("/entries/" + iIndex));
            const aItems = this._groupByItem(aEntries);
            oModel.setProperty("/posting", true);
            this._postGR(sDelivery, aIndexes, aItems);
        },

        // one step per delivery item (quantity, batch and its serial numbers) and one for the goods receipt
        _openPostGRProgress(sDelivery, aItems) {
            const iTotal = aItems.reduce((iSum, oItem) => iSum + 1 + oItem.serialNumbers.length, 0) + 1;
            const oProgress = this.getView().getModel("progress");
            oProgress.setData({
                delivery: sDelivery,
                done: 0,
                total: iTotal,
                percent: 0,
                displayValue: this._getText("postGrProgressValue", [0, iTotal]),
                state: "None",
                running: true,
                statusText: "",
                steps: aItems.map((oItem) => ({
                    title: this._getText("postGrProgressItem", [oItem.item]),
                    description: this._itemStepText(oItem, 0),
                    status: "pending"
                })).concat({
                    title: this._getText("postGrProgressGr", [sDelivery]),
                    description: "",
                    status: "pending"
                })
            });
            if (!this._pProgressDialog) {
                this._pProgressDialog = this.loadFragment({ name: "com.ewm.zrfinbound.view.PostGRProgress" });
            }
            return this._pProgressDialog.then((oDialog) => oDialog.open());
        },

        _itemStepText(oItem, iAssigned) {
            const sQuantity = oItem.quantity + " " + (oItem.unit || "");
            return oItem.serialNumbers.length
                ? this._getText("postGrProgressItemSerials", [sQuantity, iAssigned, oItem.serialNumbers.length])
                : this._getText("postGrProgressItemQuantity", [sQuantity]);
        },

        _setStep(iStep, mValues, sStatusText) {
            const oProgress = this.getView().getModel("progress");
            Object.keys(mValues).forEach((sKey) => oProgress.setProperty("/steps/" + iStep + "/" + sKey, mValues[sKey]));
            if (sStatusText) {
                oProgress.setProperty("/statusText", sStatusText);
            }
        },

        _advanceProgress() {
            const oProgress = this.getView().getModel("progress");
            const iDone = oProgress.getProperty("/done") + 1;
            const iTotal = oProgress.getProperty("/total");
            oProgress.setProperty("/done", iDone);
            oProgress.setProperty("/percent", Math.round(iDone / iTotal * 100));
            oProgress.setProperty("/displayValue", this._getText("postGrProgressValue", [iDone, iTotal]));
        },

        _finishProgress(sState, sStatusText) {
            const oProgress = this.getView().getModel("progress");
            oProgress.setProperty("/running", false);
            oProgress.setProperty("/state", sState);
            oProgress.setProperty("/statusText", sStatusText);
        },

        // write batch and quantity to the warehouse items one after the other and assign their serial numbers,
        // then post the whole delivery; the progress dialog shows each step
        async _postGR(sDelivery, aIndexes, aItems) {
            const oModel = this.getView().getModel("view");
            const oComponent = this.getOwnerComponent();
            const iGrStep = aItems.length;
            let iStep = 0;

            await this._openPostGRProgress(sDelivery, aItems);
            try {
                for (; iStep < aItems.length; iStep++) {
                    const oItem = aItems[iStep];
                    this._setStep(iStep, { status: "running" }, this._getText("postGrProgressUpdating", [oItem.item]));
                    try {
                        await ewmOperations.updateItem(oComponent, sDelivery, oItem.item, {
                            batch: oItem.batch,
                            quantity: oItem.quantity,
                            unit: oItem.unit
                        });
                    } catch (oError) {
                        throw new Error(this._getText("itemUpdateError", [oError.message || ""]));
                    }
                    this._advanceProgress();

                    for (let iSerial = 0; iSerial < oItem.serialNumbers.length; iSerial++) {
                        const sSerialNumber = oItem.serialNumbers[iSerial];
                        this._setStep(iStep, {}, this._getText("postGrProgressAssigning",
                            [oItem.item, sSerialNumber, iSerial + 1, oItem.serialNumbers.length]));
                        try {
                            await ewmOperations.assignSerialNumber(oComponent, sDelivery, oItem.item, sSerialNumber);
                        } catch (oError) {
                            throw new Error(this._getText("serialAssignError", [sSerialNumber, oError.message || ""]));
                        }
                        this._setStep(iStep, { description: this._itemStepText(oItem, iSerial + 1) });
                        this._advanceProgress();
                    }
                    this._setStep(iStep, { status: "done" });
                }

                this._setStep(iGrStep, { status: "running" }, this._getText("postGrProgressPosting", [sDelivery]));
                try {
                    await ewmOperations.postGoodsReceipt(oComponent, sDelivery);
                } catch (oError) {
                    throw new Error(this._getText("grPostError", [sDelivery, oError.message || ""]));
                }
                this._setStep(iGrStep, { status: "done" });
                this._advanceProgress();
            } catch (oError) {
                // the failed step is marked, the following ones stay waiting
                this._setStep(Math.min(iStep, iGrStep), { status: "error", description: oError.message });
                this._finishProgress("Error", oError.message);
                oModel.setProperty("/posting", false);
                return;
            }

            this._finishProgress("Success", this._getText("grPosted", [sDelivery]));
            oModel.setProperty("/posting", false);
            oModel.setProperty("/posted", true);
            this._updateCanPost();
            // the posting is marked on the entries only when the launchpad user is known
            rfHuInbound.getUserId().then((sUser) => sUser && this._updateEntries(
                aIndexes, { GoodsReceiptDoneBy: sUser }))
                .catch((oError) => MessageBox.error(this._getText("grDoneByError", [oError.message || ""])));
        },

        formatStepIcon(sStatus) {
            return {
                running: "sap-icon://synchronize",
                done: "sap-icon://sys-enter-2",
                error: "sap-icon://error"
            }[sStatus] || "sap-icon://pending";
        },

        formatStepText(sStatus) {
            return this._getText({
                running: "postGrStepRunning",
                done: "postGrStepDone",
                error: "postGrStepError"
            }[sStatus] || "postGrStepPending");
        },

        formatStepState(sStatus) {
            return { running: "Information", done: "Success", error: "Error" }[sStatus] || "None";
        },

        // the dialog stays open while posting, so the steps are not interrupted
        onPostGRProgressEscape(oPromise) {
            if (this.getView().getModel("progress").getProperty("/running")) {
                oPromise.reject();
            } else {
                oPromise.resolve();
            }
        },

        onPostGRProgressClose() {
            this.byId("postGrProgressDialog").close();
        },

        onRefresh() {
            this._loadEntries();
        },

        onNavBack() {
            this.getOwnerComponent().getRouter().navTo("RouteView1", {}, true);
        },

        _getText(sKey, aArgs) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        }
    });
});
