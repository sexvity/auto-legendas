/*
  CSInterface minimo (subconjunto compativel com o da Adobe).
  Basta para: rodar ExtendScript no After Effects e descobrir a pasta da extensao.
*/
var SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
};

function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
    if (callback === null || callback === undefined) {
        callback = function () {};
    }
    window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getOSInformation = function () {
    var userAgent = navigator.userAgent;
    if (navigator.platform === "Win32" || navigator.platform === "Windows") {
        return "Windows";
    }
    if (userAgent.indexOf("Mac") >= 0) {
        return "Mac";
    }
    return "Unknown";
};

CSInterface.prototype.getSystemPath = function (pathType) {
    var path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
    var os = this.getOSInformation();
    if (os === "Windows") {
        path = path.replace("file:///", "");
    } else if (os === "Mac") {
        path = path.replace("file://", "");
    }
    return path;
};

/* Tema do After Effects (cores do painel) */
var ThemeColorChangedEvent = "com.adobe.csxs.events.ThemeColorChanged";

CSInterface.prototype.getHostEnvironment = function () {
    try {
        return JSON.parse(window.__adobe_cep__.getHostEnvironment());
    } catch (e) {
        return null;
    }
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
    window.__adobe_cep__.addEventListener(type, listener, obj);
};
