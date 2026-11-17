sap.ui.define([
    "sap/ui/core/UIComponent",
    "com/ewm/zrfinbound/model/models"
], (UIComponent, models) => {
    "use strict";

    return UIComponent.extend("com.ewm.zrfinbound.Component", {
        metadata: {
            manifest: "json",
            interfaces: [
                "sap.ui.core.IAsyncContentCreation"
            ]
        },

        init() {
            // call the base component's init function
            UIComponent.prototype.init.apply(this, arguments);

            // set the device model
            this.setModel(models.createDeviceModel(), "device");

            // serialisation, GTINs and pack materials come from the main service; one model instance is shared
            // under the old names, as separate instances each fetch a CSRF token and invalidate each other's,
            // so their $batch requests fail with 403
            const oMainModel = this.getModel();
            ["serialisation", "gtin", "packMat"].forEach((sName) => this.setModel(oMainModel, sName));

            // enable routing
            this.getRouter().initialize();
        }
    });
});