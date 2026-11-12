sap.ui.define([], function () {
    "use strict";

    // the operations service only answers POST and PATCH, so the CSRF token is fetched from the RF HU service
    var pToken = null;

    function manifestUri(oComponent, sDataSource) {
        return oComponent.getManifestObject().resolveUri(
            oComponent.getManifestEntry("/sap.app/dataSources/" + sDataSource + "/uri"));
    }

    function fetchToken(oComponent) {
        if (!pToken) {
            pToken = fetch(manifestUri(oComponent, "rfHuInboundService"), {
                method: "HEAD",
                credentials: "same-origin",
                headers: { "X-CSRF-Token": "Fetch" }
            }).then(function (oResponse) {
                return oResponse.headers.get("X-CSRF-Token") || "";
            });
            pToken.catch(function () {
                pToken = null;
            });
        }
        return pToken;
    }

    // the operations service keeps the EWM delivery with leading zeros and the item without, e.g. 0180000046 and 40
    function deliveryNumber(sDelivery) {
        return String(sDelivery).padStart(10, "0");
    }

    function itemNumber(sItem) {
        return String(sItem).replace(/^0+(?=.)/, "");
    }

    // the service only says "API modification failed", the EWM error and its details come as JSON text in Response
    function errorMessage(oResult) {
        var oError;
        try {
            oError = JSON.parse(oResult.Response).error;
        } catch {
            oError = null;
        }
        if (!oError || !oError.message) {
            return oResult.Message;
        }
        return [oError.message].concat((oError.details || []).map(function (oDetail) {
            return oDetail.message;
        })).filter(function (sMessage, iIndex, aMessages) {
            return sMessage && aMessages.indexOf(sMessage) === iIndex;
        }).join("\n");
    }

    function send(oComponent, sDataSource, sMethod, oBody, mHeaders, bRetried) {
        return fetchToken(oComponent).then(function (sToken) {
            return fetch(manifestUri(oComponent, sDataSource), {
                method: sMethod,
                credentials: "same-origin",
                headers: Object.assign({
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "If-Match": "*",
                    "X-CSRF-Token": sToken
                }, mHeaders),
                body: JSON.stringify(oBody)
            });
        }).then(function (oResponse) {
            // an expired token is fetched again once
            if (oResponse.status === 403 && !bRetried
                && (oResponse.headers.get("X-CSRF-Token") || "").toLowerCase() === "required") {
                pToken = null;
                return send(oComponent, sDataSource, sMethod, oBody, mHeaders, true);
            }
            return oResponse.text().then(function (sText) {
                var oResult = {};
                try {
                    oResult = sText ? JSON.parse(sText) : {};
                } catch {
                    oResult = { Message: sText };
                }
                if (!oResponse.ok || oResult.Success === false || oResult.HttpStatus >= 400) {
                    throw new Error(errorMessage(oResult) || oResponse.status + " " + oResponse.statusText);
                }
                return oResult;
            });
        });
    }

    /* eslint-disable camelcase -- the operations service expects these field names */
    return {
        /**
         * Writes quantity, unit and batch to an EWM inbound delivery item.
         * @param {sap.ui.core.UIComponent} oComponent The app component, for the service URLs.
         * @param {string} sDelivery The inbound delivery.
         * @param {string} sItem The inbound delivery item.
         * @param {{quantity: string|number, unit: string, batch: string}} oValues The values to write.
         * @returns {Promise<object>} The service's answer.
         */
        updateItem: function (oComponent, sDelivery, sItem, oValues) {
            return send(oComponent, "ewmOperationsService", "PATCH", {
                operation: "UPDATE_ITEM",
                ewm_delivery: deliveryNumber(sDelivery),
                ewm_item: itemNumber(sItem),
                Product_Quantity: Number(oValues.quantity),
                Quantity_Unit: oValues.unit,
                Batch: oValues.batch || ""
            });
        },

        /**
         * Assigns a serial number to an EWM inbound delivery item.
         * @param {sap.ui.core.UIComponent} oComponent The app component, for the service URLs.
         * @param {string} sDelivery The inbound delivery.
         * @param {string} sItem The inbound delivery item.
         * @param {string} sSerialNumber The serial number.
         * @returns {Promise<object>} The service's answer.
         */
        assignSerialNumber: function (oComponent, sDelivery, sItem, sSerialNumber) {
            return send(oComponent, "ewmOperationsService", "POST", {
                operation: "ASSIGN_SERIAL",
                ewm_delivery: deliveryNumber(sDelivery),
                ewm_item: itemNumber(sItem),
                Serial_Number: sSerialNumber
            });
        },

        /**
         * Posts the goods receipt for a whole EWM inbound delivery.
         * @param {sap.ui.core.UIComponent} oComponent The app component, for the service URLs.
         * @param {string} sDelivery The inbound delivery.
         * @returns {Promise<object>} The service's answer.
         */
        postGoodsReceipt: function (oComponent, sDelivery) {
            return send(oComponent, "ewmOperationsService", "POST", {
                Operation: "POST_GR",
                ewm_delivery: deliveryNumber(sDelivery)
            });
        },

        /**
         * Creates a handling unit. Only pack material and HU number are entered, the rest is hardcoded for now.
         * @param {sap.ui.core.UIComponent} oComponent The app component, for the service URLs.
         * @param {string} sPackagingMaterial The pack material.
         * @param {string} sHandlingUnit The HU number.
         * @returns {Promise<object>} The service's answer.
         */
        createHandlingUnit: function (oComponent, sPackagingMaterial, sHandlingUnit) {
            return send(oComponent, "handlingUnitCreateService", "POST", {
                Warehouse: "UK02",
                HandlingUnitExternalID: sHandlingUnit,
                PackagingMaterial: sPackagingMaterial,
                StorageBin: "GR-AREA",
                _HandlingUnitItem: [
                    {
                        Warehouse: "UK02",
                        HandlingUnitExternalID: sHandlingUnit,
                        StockItemUUID: "0f1b4d10-3dd7-1fd1-a5df-3720ad81763f",
                        HandlingUnitQuantity: 1,
                        HandlingUnitQuantityUnit: "PC",
                        HandlingUnitAltUnitOfMeasure: "PC"
                    },
                    {
                        Warehouse: "UK02",
                        HandlingUnitExternalID: sHandlingUnit,
                        StockItemUUID: "0f1b4d10-3dd7-1fd1-a5b0-846b8fa3d63a",
                        HandlingUnitQuantity: 1,
                        HandlingUnitQuantityUnit: "PC",
                        HandlingUnitAltUnitOfMeasure: "PC",
                        HandlingUnitReferenceDocument: "180000024",
                        HandlingUnitRefDocumentItem: "0000000010"
                    }
                ]
            }, { "x-operation": "CREATE_HU" });
        }
    };
    /* eslint-enable camelcase */
});
