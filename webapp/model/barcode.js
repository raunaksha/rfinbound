sap.ui.define([], function () {
    "use strict";

    var GS = "\u001d";

    // GS1 application identifiers read from the product barcode; length is set for fixed-length AIs
    var mAIs = {
        "01": { field: "product", length: 14 },
        "17": { field: "sled", length: 6 },
        "10": { field: "batch" },
        "21": { field: "serial" }
    };

    // GS1 check digit: weights 3 and 1 alternate from the digit left of the check digit
    function hasValidCheckDigit(sGtin) {
        var iSum = 0;
        var iWeight = 3;
        for (var i = sGtin.length - 2; i >= 0; i--) {
            iSum += Number(sGtin[i]) * iWeight;
            iWeight = 4 - iWeight;
        }
        return (10 - iSum % 10) % 10 === Number(sGtin[sGtin.length - 1]);
    }

    function isGtin(sValue) {
        return /^(\d{8}|\d{12,14})$/.test(sValue) && hasValidCheckDigit(sValue);
    }

    function parseBracketed(sBarcode, oResult) {
        var rAI = /\((\d{2,4})\)([^(]*)/g;
        var aMatch = rAI.exec(sBarcode);

        while (aMatch) {
            if (mAIs[aMatch[1]]) {
                oResult[mAIs[aMatch[1]].field] = aMatch[2].trim();
            }
            aMatch = rAI.exec(sBarcode);
        }
    }

    function parseRaw(sBarcode, oResult) {
        var iPos = 0;

        while (iPos < sBarcode.length) {
            if (sBarcode[iPos] === GS) {
                iPos++;
                continue;
            }
            var oAI = mAIs[sBarcode.substr(iPos, 2)];
            if (!oAI) {
                return false;
            }
            iPos += 2;
            // a space between application identifier and value separates nothing
            while (sBarcode[iPos] === GS) {
                iPos++;
            }
            var iEnd = sBarcode.indexOf(GS, iPos);
            if (iEnd < 0) {
                iEnd = sBarcode.length;
            }
            if (oAI.length) {
                iEnd = Math.min(iEnd, iPos + oAI.length);
            }
            // some labels carry the 13 digit EAN after AI 01 instead of the 14 digit GTIN
            var sGtin = sBarcode.substring(iPos, iEnd);
            if (oAI.field === "product" && sGtin.length === 14 && !hasValidCheckDigit(sGtin)
                && isGtin(sGtin.substring(0, 13))) {
                iEnd--;
            }
            oResult[oAI.field] = sBarcode.substring(iPos, iEnd);
            iPos = iEnd;
        }
        return true;
    }

    return {
        /**
         * Splits a scanned product barcode into product (the GTIN for GS1 barcodes), SLED (YYMMDD), batch and
         * serial number. GS1 barcodes are read by application identifier; anything else is taken as the product.
         * @param {string} sBarcode The scanned barcode.
         * @returns {{product: string, sled: string, batch: string, serial: string}} The scanned values.
         */
        parse: function (sBarcode) {
            var oResult = { product: "", sled: "", batch: "", serial: "" };
            // drop the symbology identifier some scanners prefix, e.g. ]C1 or ]d2
            var sValue = (sBarcode || "").trim().replace(/^\][A-Za-z]\d/, "");

            if (sValue.charAt(0) === "(") {
                parseBracketed(sValue, oResult);
            // GS1 data holds no spaces, so spaces between the fields separate them like GS does
            } else if (!parseRaw(sValue.replace(/\s+/g, GS), oResult) || !oResult.product) {
                oResult = { product: sValue, sled: "", batch: "", serial: "" };
            }
            return oResult;
        },

        /**
         * Tells whether a value is a GTIN (EAN-8, UPC-A, EAN-13 or GTIN-14) with a valid check digit.
         * @param {string} sValue The value.
         * @returns {boolean} Whether the value is a GTIN.
         */
        isGtin: isGtin,

        /**
         * Turns a SLED (YYMMDD) into an OData date (YYYY-MM-DD). Day 00 stands for the last day of the month.
         * @param {string} sSled The SLED.
         * @returns {string|null} The date, or null when the SLED is empty or no valid date.
         */
        sledToDate: function (sSled) {
            var aMatch = /^(\d{2})(\d{2})(\d{2})$/.exec((sSled || "").trim());
            if (!aMatch) {
                return null;
            }
            var iYear = 2000 + Number(aMatch[1]);
            var iMonth = Number(aMatch[2]);
            var iLastDay = new Date(Date.UTC(iYear, iMonth, 0)).getUTCDate();
            var iDay = Number(aMatch[3]) || iLastDay;
            if (iMonth < 1 || iMonth > 12 || iDay > iLastDay) {
                return null;
            }
            return iYear + "-" + aMatch[2] + "-" + String(iDay).padStart(2, "0");
        },

        /**
         * Turns an OData date (YYYY-MM-DD) back into a SLED (YYMMDD).
         * @param {string} sDate The date.
         * @returns {string} The SLED, empty when there is no date.
         */
        dateToSled: function (sDate) {
            var aMatch = /^\d{2}(\d{2})-(\d{2})-(\d{2})/.exec(sDate || "");
            return aMatch ? aMatch[1] + aMatch[2] + aMatch[3] : "";
        }
    };
});
