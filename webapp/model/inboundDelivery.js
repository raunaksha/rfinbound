/* global Promise */
sap.ui.define([], function () {
    "use strict";

    var ENTITY_SET = "/ZC_InboundDelv";

    function literal(sValue) {
        return "'" + String(sValue).replace(/'/g, "''") + "'";
    }

    var pExternalUnits = null;

    // the service returns the internal unit, e.g. ST, but the custom table and EWM only accept the external one,
    // e.g. PC; the mapping comes from the units code list the service's metadata points to
    function requestExternalUnits(oModel) {
        if (!pExternalUnits) {
            var sUrl = new URL("../../../../default/iwbep/common/0001/UnitsOfMeasure",
                new URL(oModel.getServiceUrl(), window.location.href)).href;
            pExternalUnits = fetch(sUrl, {
                credentials: "same-origin",
                headers: { "Accept": "application/json" }
            }).then(function (oResponse) {
                if (!oResponse.ok) {
                    throw new Error(oResponse.status + " " + oResponse.statusText);
                }
                return oResponse.json();
            }).then(function (oData) {
                var mUnits = {};
                (oData.value || []).forEach(function (oUnit) {
                    mUnits[oUnit.UnitCode] = oUnit.ExternalCode || oUnit.UnitCode;
                });
                return mUnits;
            });
            // without the code list the units stay as read, and the next read tries again
            pExternalUnits = pExternalUnits.catch(function () {
                pExternalUnits = null;
                return {};
            });
        }
        return pExternalUnits;
    }

    // the service adds the leading zeros itself, so delivery and purchase order are filtered as scanned
    function readItems(oModel, sFilter, iTop) {
        return Promise.all([
            oModel.bindList(ENTITY_SET, undefined, undefined, undefined, { $filter: sFilter })
                .requestContexts(0, iTop || Infinity),
            requestExternalUnits(oModel)
        ]).then(function (aResults) {
            var mUnits = aResults[1];
            return aResults[0].map(function (oContext) {
                // a copy, as the model's cached data must not be changed
                var oItem = Object.assign({}, oContext.getObject());
                oItem.DeliveryQuantityUnit = mUnits[oItem.DeliveryQuantityUnit] || oItem.DeliveryQuantityUnit;
                return oItem;
            }).sort(function (oA, oB) {
                return oA.InboundDelivery.localeCompare(oB.InboundDelivery)
                    || Number(oA.InboundDeliveryItem) - Number(oB.InboundDeliveryItem);
            });
        });
    }

    return {
        /**
         * Reads the inbound delivery items that reference a purchase order.
         * @param {sap.ui.model.odata.v4.ODataModel} oModel The custom inbound delivery service model.
         * @param {string} sPurchaseOrder The purchase order.
         * @param {number} [iTop] The maximum number of items; all when left out.
         * @returns {Promise<object[]>} The items, sorted by delivery and item.
         */
        readByPurchaseOrder: function (oModel, sPurchaseOrder, iTop) {
            return readItems(oModel, "ReferenceSDDocument eq " + literal(sPurchaseOrder), iTop);
        },

        /**
         * Reads the items of an inbound delivery.
         * @param {sap.ui.model.odata.v4.ODataModel} oModel The custom inbound delivery service model.
         * @param {string} sDelivery The inbound delivery.
         * @param {number} [iTop] The maximum number of items; all when left out.
         * @returns {Promise<object[]>} The items, sorted by item.
         */
        readByDelivery: function (oModel, sDelivery, iTop) {
            return readItems(oModel, "InboundDelivery eq " + literal(sDelivery), iTop);
        },

        /**
         * Reads the goods receipt document posted for an inbound delivery item.
         * @param {sap.ui.model.odata.v4.ODataModel} oModel The custom inbound delivery service model.
         * @param {string} sDelivery The inbound delivery, without leading zeros.
         * @param {string} sDeliveryItem The inbound delivery item, without leading zeros.
         * @returns {Promise<string>} The goods receipt document, empty when none was posted.
         */
        readGrDocument: function (oModel, sDelivery, sDeliveryItem) {
            var sFilter = "inbound_delv eq " + literal(sDelivery) + " and inbound_delv_item eq " + literal(sDeliveryItem);
            var sUrl = oModel.getServiceUrl() + "ZCE_INBOUND_PGR?$filter=" + encodeURIComponent(sFilter);

            return fetch(sUrl, {
                credentials: "same-origin",
                headers: { "Accept": "application/json" }
            }).then(function (oResponse) {
                if (!oResponse.ok) {
                    throw new Error(oResponse.status + " " + oResponse.statusText);
                }
                return oResponse.json();
            }).then(function (oData) {
                var oPgr = (oData.value || []).find(function (oEntry) {
                    return oEntry.pgr_documnet;
                });
                return oPgr ? oPgr.pgr_documnet : "";
            });
        },

        /**
         * Reads quantity and number of serial numbers of an inbound delivery item from the serial number
         * service (OData V2). Serial numbers next to a quantity mean the goods receipt was posted already.
         * @param {sap.ui.core.UIComponent} oComponent The app component, for the service URL.
         * @param {string} sDelivery The inbound delivery, with or without leading zeros.
         * @param {string} sDeliveryItem The inbound delivery item, with or without leading zeros.
         * @returns {Promise<{quantity: number, serialNumbers: number}>} Zeros when the item is not found.
         */
        readSerialNumberStatus: function (oComponent, sDelivery, sDeliveryItem) {
            // the service takes the delivery without leading zeros and the item with six digits, e.g. 180000077 and 000010
            var sItem = String(sDeliveryItem).trim().replace(/^0+(?=.)/, "").padStart(6, "0");
            var sFilter = "InboundDelivery eq " + literal(String(sDelivery).trim().replace(/^0+(?=.)/, ""))
                + " and InboundDeliveryItem eq " + literal(sItem);
            var sUrl = oComponent.getManifestObject().resolveUri(
                oComponent.getManifestEntry("/sap.app/dataSources/inboundDelvSerialNumService/uri"))
                + "YY1_Inbound_Delv_SerialNum?$format=json&$filter=" + encodeURIComponent(sFilter);

            return fetch(sUrl, {
                credentials: "same-origin",
                headers: { "Accept": "application/json" }
            }).then(function (oResponse) {
                if (!oResponse.ok) {
                    throw new Error(oResponse.status + " " + oResponse.statusText);
                }
                return oResponse.json();
            }).then(function (oData) {
                return ((oData.d && oData.d.results) || []).reduce(function (oStatus, oEntry) {
                    oStatus.quantity = Math.max(oStatus.quantity, Number(oEntry.ActualDeliveryQuantity) || 0);
                    oStatus.serialNumbers += Number(oEntry.NumberOfSerialNumbers) || 0;
                    return oStatus;
                }, { quantity: 0, serialNumbers: 0 });
            });
        }
    };
});
