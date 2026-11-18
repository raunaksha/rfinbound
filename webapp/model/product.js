sap.ui.define([], function () {
    "use strict";

    function literal(sValue) {
        return "'" + String(sValue).replace(/'/g, "''") + "'";
    }

    // numeric products and GTINs may come with or without leading zeros
    function normalize(sValue) {
        return String(sValue || "").trim().replace(/^0+(?=.)/, "");
    }

    return {
        normalize: normalize,

        /**
         * Reads the product a GTIN is maintained for.
         * @param {sap.ui.model.odata.v4.ODataModel} oModel The product GTIN service model.
         * @param {string} sGtin The scanned GTIN.
         * @returns {Promise<{product: string, unit: string}|null>} The product and the unit of the GTIN,
         *   null when the GTIN is not maintained.
         */
        readByGtin: function (oModel, sGtin) {
            // a GTIN-14 is the EAN-13 with a leading zero, so both forms are looked for
            var aValues = [sGtin.trim()];
            if (normalize(sGtin) !== aValues[0]) {
                aValues.push(normalize(sGtin));
            }
            var sFilter = aValues.map(function (sValue) {
                return "ProductStandardID eq " + literal(sValue);
            }).join(" or ");

            // the service is keyed by product only, yet a product has a GTIN per unit; the OData model rejects
            // such duplicate keys, so the GTINs are read with a plain request
            var sUrl = oModel.getServiceUrl() + "Product_GTIN?$select=Product,ProductStandardID,AlternativeUnit&$filter="
                + encodeURIComponent(sFilter);

            return fetch(sUrl, {
                credentials: "same-origin",
                headers: { "Accept": "application/json" }
            }).then(function (oResponse) {
                if (!oResponse.ok) {
                    throw new Error(oResponse.status + " " + oResponse.statusText);
                }
                return oResponse.json();
            }).then(function (oData) {
                var oGtin = (oData.value || [])[0];
                return oGtin ? { product: oGtin.Product, unit: oGtin.AlternativeUnit } : null;
            });
        },

        /**
         * Reads the batches of a product, of all plants, as batches are kept at material level.
         * @param {sap.ui.model.odata.v4.ODataModel} oModel The product batch service model.
         * @param {string} sProduct The product.
         * @returns {Promise<string[]>} The batch numbers, each one once.
         */
        readBatches: function (oModel, sProduct) {
            var sFilter = "Product eq " + literal(sProduct);
            var sUrl = oModel.getServiceUrl() + "Product_Batch?$filter=" + encodeURIComponent(sFilter);

            return fetch(sUrl, {
                credentials: "same-origin",
                headers: { "Accept": "application/json" }
            }).then(function (oResponse) {
                if (!oResponse.ok) {
                    throw new Error(oResponse.status + " " + oResponse.statusText);
                }
                return oResponse.json();
            }).then(function (oData) {
                return (oData.value || []).map(function (oBatch) {
                    return oBatch.batch;
                }).filter(function (sBatch, iIndex, aBatches) {
                    // a batch may come once per plant
                    return sBatch && aBatches.indexOf(sBatch) === iIndex;
                });
            });
        },

        /**
         * Reads the serial number profile of a product in a plant. The service is read by key, as in
         * product_serialisation(Product='TENSI%2B%20SERIAL',Plant='PL01'); when the key read finds nothing,
         * a filter read is tried as well.
         * @param {sap.ui.model.odata.v4.ODataModel} oModel The model of the service with product_serialisation.
         * @param {string} sProduct The product.
         * @param {string} sPlant The plant.
         * @returns {Promise<string>} The serial number profile, empty when the product is not serialised.
         */
        readSerialNumberProfile: function (oModel, sProduct, sPlant) {
            var sSelect = "?$select=Product,Plant,SerialNumberProfile";
            var sKeyUrl = oModel.getServiceUrl() + "product_serialisation(Product="
                + encodeURIComponent(literal(sProduct)) + ",Plant=" + encodeURIComponent(literal(sPlant)) + ")" + sSelect;
            var sFilterUrl = oModel.getServiceUrl() + "product_serialisation" + sSelect + "&$filter="
                + encodeURIComponent("Product eq " + literal(sProduct) + " and Plant eq " + literal(sPlant));

            // a product without serialisation may answer the key read with 404, that means no profile
            function read(sUrl) {
                return fetch(sUrl, {
                    credentials: "same-origin",
                    headers: { "Accept": "application/json" }
                }).then(function (oResponse) {
                    if (oResponse.status === 404) {
                        return {};
                    }
                    if (!oResponse.ok) {
                        throw new Error(oResponse.status + " " + oResponse.statusText);
                    }
                    return oResponse.json();
                }).then(function (oData) {
                    var oEntry = Array.isArray(oData.value) ? oData.value[0] : oData;
                    return (oEntry && oEntry.SerialNumberProfile) || "";
                });
            }

            return read(sKeyUrl).then(function (sProfile) {
                return sProfile || read(sFilterUrl).catch(function () {
                    return "";
                });
            }, function (oError) {
                return read(sFilterUrl).catch(function () {
                    throw oError;
                });
            });
        }
    };
});
