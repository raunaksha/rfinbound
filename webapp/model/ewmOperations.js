sap.ui.define([], function () {
    "use strict";

    // the operations service is called with GET, the operation and its values passed as $filter
    var ENTITY_SET = "EWM_DELV_POST_PATCH";

    function manifestUri(oComponent, sDataSource) {
        return oComponent.getManifestObject().resolveUri(
            oComponent.getManifestEntry("/sap.app/dataSources/" + sDataSource + "/uri"));
    }

    function literal(sValue) {
        return "'" + String(sValue === undefined || sValue === null ? "" : sValue).replace(/'/g, "''") + "'";
    }

    // the operations service keeps the EWM delivery with leading zeros and the item without, e.g. 0180000046 and 40
    function deliveryNumber(sDelivery) {
        return String(sDelivery).trim().padStart(10, "0");
    }

    function itemNumber(sItem) {
        return String(sItem).trim().replace(/^0+(?=.)/, "");
    }

    // a date as Edm.Date literal, e.g. 2026-12-30, from a Date or a string that already is one
    function dateLiteral(vDate) {
        if (vDate instanceof Date) {
            return vDate.getFullYear() + "-" + String(vDate.getMonth() + 1).padStart(2, "0") + "-"
                + String(vDate.getDate()).padStart(2, "0");
        }
        return String(vDate).trim();
    }

    // the result fields may come in any case, e.g. Success or success
    function field(oResult, sName) {
        var sKey = Object.keys(oResult || {}).find(function (sCandidate) {
            return sCandidate.toLowerCase() === sName.toLowerCase();
        });
        return sKey ? oResult[sKey] : undefined;
    }

    function messages(oError) {
        return [oError.message].concat((oError.details || []).map(function (oDetail) {
            return oDetail.message;
        })).filter(function (sMessage, iIndex, aMessages) {
            return sMessage && aMessages.indexOf(sMessage) === iIndex;
        }).join("\n");
    }

    // the service may only say "API modification failed", the EWM error and its details come as JSON text in Response
    function errorMessage(oResult) {
        var oError;
        try {
            oError = JSON.parse(field(oResult, "Response")).error;
        } catch {
            oError = null;
        }
        return oError && oError.message ? messages(oError) : field(oResult, "Message");
    }

    function failed(oResult) {
        var vSuccess = field(oResult, "Success");
        return vSuccess === false || vSuccess === "" || String(vSuccess).toLowerCase() === "false"
            || Number(field(oResult, "HttpStatus")) >= 400;
    }

    function send(oComponent, mValues) {
        var sFilter = Object.keys(mValues).map(function (sName) {
            return sName + " eq " + mValues[sName];
        }).join(" and ");
        var sUrl = manifestUri(oComponent, "ewmOperationsService") + ENTITY_SET + "?$filter="
            + encodeURIComponent(sFilter);

        return fetch(sUrl, {
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
        }).then(function (oResponse) {
            return oResponse.text().then(function (sText) {
                var oData = {};
                try {
                    oData = sText ? JSON.parse(sText) : {};
                } catch {
                    oData = { Message: sText };
                }
                if (!oResponse.ok) {
                    throw new Error((oData.error && messages(oData.error)) || errorMessage(oData)
                        || oResponse.status + " " + oResponse.statusText);
                }
                // the answer is the list of results, usually one
                var aResults = Array.isArray(oData.value) ? oData.value : [oData];
                var oFailed = aResults.find(failed);
                if (oFailed) {
                    throw new Error(errorMessage(oFailed) || oResponse.status + " " + oResponse.statusText);
                }
                return aResults[0] || {};
            });
        });
    }

    // the handling unit service only answers POST, so the CSRF token is fetched from the RF HU service
    var pToken = null;

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

    function post(oComponent, sDataSource, oBody, mHeaders, bRetried) {
        return fetchToken(oComponent).then(function (sToken) {
            return fetch(manifestUri(oComponent, sDataSource), {
                method: "POST",
                credentials: "same-origin",
                headers: Object.assign({
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-CSRF-Token": sToken
                }, mHeaders),
                body: JSON.stringify(oBody)
            });
        }).then(function (oResponse) {
            // an expired token is fetched again once
            if (oResponse.status === 403 && !bRetried
                && (oResponse.headers.get("X-CSRF-Token") || "").toLowerCase() === "required") {
                pToken = null;
                return post(oComponent, sDataSource, oBody, mHeaders, true);
            }
            return oResponse.text().then(function (sText) {
                var oResult = {};
                try {
                    oResult = sText ? JSON.parse(sText) : {};
                } catch {
                    oResult = { Message: sText };
                }
                if (!oResponse.ok || failed(oResult)) {
                    throw new Error(errorMessage(oResult) || oResponse.status + " " + oResponse.statusText);
                }
                return oResult;
            });
        });
    }

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
            return send(oComponent, {
                Operation: literal("UPDATE_ITEM"),
                EwmDelivery: literal(deliveryNumber(sDelivery)),
                EwmItem: literal(itemNumber(sItem)),
                ProductQuantity: String(Number(oValues.quantity) || 0),
                QuantityUnit: literal(oValues.unit),
                Batch: literal(oValues.batch)
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
            return send(oComponent, {
                Operation: literal("ASSIGN_SERIAL"),
                EwmDelivery: literal(deliveryNumber(sDelivery)),
                EwmItem: literal(itemNumber(sItem)),
                SerialNumber: literal(sSerialNumber)
            });
        },

        /**
         * Posts the goods receipt for a whole EWM inbound delivery.
         * @param {sap.ui.core.UIComponent} oComponent The app component, for the service URLs.
         * @param {string} sDelivery The inbound delivery.
         * @returns {Promise<object>} The service's answer.
         */
        postGoodsReceipt: function (oComponent, sDelivery) {
            return send(oComponent, {
                Operation: literal("POST_GR"),
                EwmDelivery: literal(deliveryNumber(sDelivery))
            });
        },

        /**
         * Creates a batch of a material.
         * @param {sap.ui.core.UIComponent} oComponent The app component, for the service URLs.
         * @param {string} sMaterial The material.
         * @param {string} sPlant The plant, may be empty.
         * @param {string} sBatch The batch number.
         * @param {Date|string} vShelfLifeExpiry The shelf life expiry date, a Date or YYYY-MM-DD.
         * @returns {Promise<object>} The service's answer.
         */
        createBatch: function (oComponent, sMaterial, sPlant, sBatch, vShelfLifeExpiry) {
            return send(oComponent, {
                Operation: literal("CREATE_BATCH"),
                Material: literal(sMaterial),
                Plant: literal(sPlant),
                Batch: literal(sBatch),
                ShelfLifeExpiry: dateLiteral(vShelfLifeExpiry)
            });
        },

        /**
         * Creates a handling unit. Only pack material and HU number are entered, the warehouse is always UK02
         * and the rest is hardcoded for now.
         * @param {sap.ui.core.UIComponent} oComponent The app component, for the service URLs.
         * @param {string} sPackagingMaterial The pack material.
         * @param {string} sHandlingUnit The HU number.
         * @returns {Promise<object>} The service's answer.
         */
        createHandlingUnit: function (oComponent, sPackagingMaterial, sHandlingUnit) {
            return post(oComponent, "handlingUnitCreateService", {
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
});
