/* global Promise */
sap.ui.define([
    "sap/ui/core/Messaging"
], function (Messaging) {
    "use strict";

    var ENTITY_SET = "ZC_RFHU_INBOUND";
    var CREATE_GROUP = "rfHuCreate";

    function literal(sValue) {
        return "'" + String(sValue).replace(/'/g, "''") + "'";
    }

    // the custom table keeps delivery and item without leading zeros, e.g. 180000073 and 10
    // instead of 0180000073 and 000010
    function itemNumber(sDeliveryItem) {
        return String(sDeliveryItem).replace(/^0+(?=.)/, "");
    }

    function deliveryNumber(sDelivery) {
        return String(sDelivery).trim().replace(/^0+(?=.)/, "");
    }

    // the service may expose the table in any case, e.g. ZC_RFHU_INBOUND, so take the name from the metadata
    function requestEntitySet(oModel) {
        return oModel.getMetaModel().requestObject("/").then(function (oContainer) {
            var sName = Object.keys(oContainer).find(function (sKey) {
                return oContainer[sKey].$kind === "EntitySet" && sKey.toUpperCase() === ENTITY_SET;
            });
            if (!sName) {
                throw new Error("Entity set " + ENTITY_SET + " not found in the service, it has: "
                    + Object.keys(oContainer).filter(function (sKey) {
                        return oContainer[sKey].$kind === "EntitySet";
                    }).join(", "));
            }
            return "/" + sName;
        });
    }

    // failed creates only report through the message model, so take the newest backend error from there
    function lastBackendError() {
        var aErrors = Messaging.getMessageModel().getData().filter(function (oMessage) {
            return oMessage.getType() === "Error";
        });
        return new Error(aErrors.length ? aErrors[aErrors.length - 1].getMessage() : "");
    }

    return {
        itemNumber: itemNumber,
        deliveryNumber: deliveryNumber,

        /**
         * Reads the stored entries of an inbound delivery, or of one of its items.
         * @param {sap.ui.model.odata.v4.ODataModel} oModel The RF HU inbound service model.
         * @param {string} sDelivery The inbound delivery.
         * @param {string} [sDeliveryItem] The inbound delivery item; all items when left out.
         * @returns {Promise<sap.ui.model.odata.v4.Context[]>} The entries, sorted by item and serial number.
         */
        readEntries: function (oModel, sDelivery, sDeliveryItem) {
            var sFilter = "InboundDelivery eq " + literal(deliveryNumber(sDelivery));
            if (sDeliveryItem) {
                sFilter += " and InboundDeliveryItem eq " + literal(itemNumber(sDeliveryItem));
            }

            return requestEntitySet(oModel).then(function (sEntitySet) {
                return oModel.bindList(sEntitySet, undefined, undefined, undefined, { $filter: sFilter })
                    .requestContexts(0, Infinity);
            }).then(function (aContexts) {
                return aContexts.sort(function (oA, oB) {
                    var oEntryA = oA.getObject();
                    var oEntryB = oB.getObject();
                    return Number(oEntryA.InboundDeliveryItem) - Number(oEntryB.InboundDeliveryItem)
                        || String(oEntryA.SerialNumber).localeCompare(String(oEntryB.SerialNumber));
                });
            });
        },

        /**
         * Creates entries in one change set, so either all of them are stored or none.
         * @param {sap.ui.model.odata.v4.ODataModel} oModel The RF HU inbound service model.
         * @param {object[]} aEntries The entries to create.
         * @returns {Promise} Resolves when all entries are created.
         */
        createEntries: function (oModel, aEntries) {
            return requestEntitySet(oModel).then(function (sEntitySet) {
                return new Promise(function (fnResolve, fnReject) {
                    var oBinding = oModel.bindList(sEntitySet, undefined, undefined, undefined, {
                        $$updateGroupId: CREATE_GROUP
                    });
                    var iOpen = aEntries.length;
                    var bFailed = false;

                    oBinding.attachCreateCompleted(function (oEvent) {
                        bFailed = bFailed || !oEvent.getParameter("success");
                        iOpen--;
                        if (iOpen > 0) {
                            return;
                        }
                        if (bFailed) {
                            // drop the entries that were not created so a new save starts clean
                            var oError = lastBackendError();
                            oModel.resetChanges(CREATE_GROUP);
                            fnReject(oError);
                        } else {
                            fnResolve();
                        }
                    });
                    aEntries.forEach(function (oEntry) {
                        // the created promise is rejected by resetChanges, which is reported above already
                        oBinding.create(oEntry, true).created().catch(function () {});
                    });
                    oModel.submitBatch(CREATE_GROUP);
                });
            });
        },

        /**
         * Deletes entries.
         * @param {sap.ui.model.odata.v4.Context[]} aContexts The entries read with readEntries.
         * @returns {Promise} Resolves when all entries are deleted.
         */
        deleteEntries: function (aContexts) {
            return Promise.all(aContexts.map(function (oContext) {
                return oContext.delete("$auto");
            }));
        },

        /**
         * Changes fields of an entry in one PATCH.
         * @param {sap.ui.model.odata.v4.Context} oContext The entry read with readEntries.
         * @param {object} mValues The fields to change.
         * @returns {Promise} Resolves when the entry is updated.
         */
        updateEntry: function (oContext, mValues) {
            return Promise.all(Object.keys(mValues).map(function (sProperty) {
                return oContext.setProperty(sProperty, mValues[sProperty], "$auto");
            }));
        },

        /**
         * Reads the ID of the user logged on to the launchpad.
         * @returns {Promise<string>} The user ID, empty outside the launchpad.
         */
        getUserId: function () {
            var oContainer = sap.ui.require("sap/ushell/Container") || (sap.ushell && sap.ushell.Container);
            if (!oContainer) {
                return Promise.resolve("");
            }
            return oContainer.getServiceAsync("UserInfo").then(function (oUserInfo) {
                return oUserInfo.getId() || "";
            }, function () {
                return "";
            });
        }
    };
});
