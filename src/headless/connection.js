import log from "./log";
import { Strophe } from 'strophe.js/src/core';
import { _converse, api, clearSession, tearDown } from "./converse-core";
import { __ } from './i18n';
import u from "./utils/core";
import { debounce } from 'lodash-es';


const BOSH_WAIT = 59;
const parser = new DOMParser();


export class Connection extends Strophe.Connection {

    async bind () {
        /**
         * Synchronous event triggered before we send an IQ to bind the user's
         * JID resource for this session.
         * @event _converse#beforeResourceBinding
         */
        await api.trigger('beforeResourceBinding', {'synchronous': true});
        super.bind();
    }

    connect (jid, password, callback) {
        super.connect(_converse.jid, password, callback || this.onConnectStatusChanged, BOSH_WAIT);
    }

    async reconnect () {
        log.debug('RECONNECTING: the connection has dropped, attempting to reconnect.');
        _converse.setConnectionStatus(
            Strophe.Status.RECONNECTING,
            __('The connection has dropped, attempting to reconnect.')
        );
        /**
        * Triggered when the connection has dropped, but Converse will attempt
        * to reconnect again.
        *
        * @event _converse#will-reconnect
        */
        _converse.api.trigger('will-reconnect');

        this.reconnecting = true;
        await tearDown();
        return _converse.api.user.login();
    }

    /**
     * Called as soon as a new connection has been established, either
     * by logging in or by attaching to an existing BOSH session.
     */
    async onConnected (reconnecting) {
        delete this.reconnecting;
        this.flush(); // Solves problem of returned PubSub BOSH response not received by browser
        await _converse.setUserJID(this.jid);

        /**
         * Synchronous event triggered after we've sent an IQ to bind the
         * user's JID resource for this session.
         * @event _converse#afterResourceBinding
         */
        await api.trigger('afterResourceBinding', reconnecting, {'synchronous': true});

        if (reconnecting) {
            /**
             * After the connection has dropped and converse.js has reconnected.
             * Any Strophe stanza handlers (as registered via `converse.listen.stanza`) will
             * have to be registered anew.
             * @event _converse#reconnected
             * @example _converse.api.listen.on('reconnected', () => { ... });
             */
            api.trigger('reconnected');
        } else {
            /**
             * Triggered once converse.js has been initialized.
             * See also {@link _converse#event:pluginsInitialized}.
             * @event _converse#initialized
             */
            api.trigger('initialized');
            /**
             * Triggered after the connection has been established and Converse
             * has got all its ducks in a row.
             * @event _converse#initialized
             */
            api.trigger('connected');
        }
    }

    /**
     * Used to keep track of why we got disconnected, so that we can
     * decide on what the next appropriate action is (in onDisconnected)
     */
    setDisconnectionCause (cause, reason, override) {
        if (cause === undefined) {
            delete this.disconnection_cause;
            delete this.disconnection_reason;
        } else if (this.disconnection_cause === undefined || override) {
            this.disconnection_cause = cause;
            this.disconnection_reason = reason;
        }
    }

    async finishDisconnection () {
        // Properly tear down the session so that it's possible to manually connect again.
        log.debug('DISCONNECTED');
        delete this.reconnecting;
        this.reset();
        tearDown();
        await clearSession();
        delete _converse.connection;
        /**
        * Triggered after converse.js has disconnected from the XMPP server.
        * @event _converse#disconnected
        * @memberOf _converse
        * @example _converse.api.listen.on('disconnected', () => { ... });
        */
        api.trigger('disconnected');
    }

    /**
     * Gets called once strophe's status reaches Strophe.Status.DISCONNECTED.
     * Will either start a teardown process for converse.js or attempt
     * to reconnect.
     * @method onDisconnected
     */
    onDisconnected () {
        if (api.settings.get("auto_reconnect")) {
            const reason = this.disconnection_reason;
            if (this.disconnection_cause === Strophe.Status.AUTHFAIL) {
                if (api.settings.get("credentials_url") || api.settings.get("authentication") === _converse.ANONYMOUS) {
                    // If `credentials_url` is set, we reconnect, because we might
                    // be receiving expirable tokens from the credentials_url.
                    //
                    // If `authentication` is anonymous, we reconnect because we
                    // might have tried to attach with stale BOSH session tokens
                    // or with a cached JID and password
                    return api.connection.reconnect();
                } else {
                    return this.finishDisconnection();
                }
            } else if (
                this.disconnection_cause === _converse.LOGOUT ||
                reason === Strophe.ErrorCondition.NO_AUTH_MECH ||
                reason === "host-unknown" ||
                reason === "remote-connection-failed"
            ) {
                return this.finishDisconnection();
            }
            api.connection.reconnect();
        } else {
            return this.finishDisconnection();
        }
    }

    /**
     * Callback method called by Strophe as the Connection goes
     * through various states while establishing or tearing down a
     * connection.
     */
    onConnectStatusChanged (status, message) {
        log.debug(`Status changed to: ${_converse.CONNECTION_STATUS[status]}`);
        if (status === Strophe.Status.CONNECTED || status === Strophe.Status.ATTACHED) {
            _converse.setConnectionStatus(status);
            // By default we always want to send out an initial presence stanza.
            _converse.send_initial_presence = true;
            this.setDisconnectionCause();
            if (this.reconnecting) {
                log.debug(status === Strophe.Status.CONNECTED ? 'Reconnected' : 'Reattached');
                this.onConnected(true);
            } else {
                log.debug(status === Strophe.Status.CONNECTED ? 'Connected' : 'Attached');
                if (this.restored) {
                    // No need to send an initial presence stanza when
                    // we're restoring an existing session.
                    _converse.send_initial_presence = false;
                }
                this.onConnected();
            }
        } else if (status === Strophe.Status.DISCONNECTED) {
            this.setDisconnectionCause(status, message);
            this.onDisconnected();
        } else if (status === Strophe.Status.BINDREQUIRED) {
            this.bind();
        } else if (status === Strophe.Status.ERROR) {
            _converse.setConnectionStatus(
                status,
                __('An error occurred while connecting to the chat server.')
            );
        } else if (status === Strophe.Status.CONNECTING) {
            _converse.setConnectionStatus(status);
        } else if (status === Strophe.Status.AUTHENTICATING) {
            _converse.setConnectionStatus(status);
        } else if (status === Strophe.Status.AUTHFAIL) {
            if (!message) {
                message = __('Your XMPP address and/or password is incorrect. Please try again.');
            }
            _converse.setConnectionStatus(status, message);
            this.setDisconnectionCause(status, message, true);
            this.onDisconnected();
        } else if (status === Strophe.Status.CONNFAIL) {
            let feedback = message;
            if (message === "host-unknown" || message == "remote-connection-failed") {
                feedback = __("Sorry, we could not connect to the XMPP host with domain: %1$s",
                    `\"${Strophe.getDomainFromJid(this.jid)}\"`);
            } else if (message !== undefined && message === Strophe?.ErrorCondition?.NO_AUTH_MECH) {
                feedback = __("The XMPP server did not offer a supported authentication mechanism");
            }
            _converse.setConnectionStatus(status, feedback);
            this.setDisconnectionCause(status, message);
        } else if (status === Strophe.Status.DISCONNECTING) {
            this.setDisconnectionCause(status, message);
        }
    }
}


export class SharedWorkerConnectionManager extends Connection {

    constructor (service, options) {
        super (service, options);
        this.debouncedReconnect = debounce(this.reconnect, 2000);

        this.features = [];
        this.do_session = false;
        this.do_bind = false;
        this.connected = false;
        this.handlers = {};

        this.worker = new SharedWorker('./src/headless/worker.js', 'Converse XMPP Connection');
        this.worker.onerror = (e) => log.error(`Shared Worker Error: ${e}`);
        this.worker.port.start();

        this.worker.port.onmessage = ev => {
            const { data } = ev;
            const methodname = data[0];
            if (methodname in this) {
                try {
                    this[methodname].apply(this, ev.data.slice(1));
                } catch (e) {
                    log.error(e);
                }
            } else if (methodname === 'Strophe.log') {
                const level = data[1];
                const msg = data[2]
                log[level](msg)
            } else if (methodname === 'xmlInput') {
                log.debug(data[1], 'color: darkgoldenrod')
            } else if (methodname === 'xmlOutput') {
                log.debug(data[1], 'color: darkcyan');
            } else if (methodname.startsWith('handler-')) {
                const el = parser.parseFromString(data[1], "text/xml").firstElementChild;
                const result = this.handlers[methodname]?.(el);
                if (!result) {
                    this.deleteHandler(this.handlers[methodname]);
                }
            } else {
                log.error(`Found unhandled service worker message: ${data}`);
            }
        }

        this.worker.port.postMessage([
            'initConnection',
            _converse.api.settings.get("websocket_url"),
             Object.assign(_converse.default_connection_options, _converse.api.settings.get("connection_options"))
        ]);

        this._addSysHandler(el => this.saveStreamFeatures(el), null, 'stream:features');
    }

    saveStreamFeatures (el) {
        this.features = el;
        for (let i=0; i < el.childNodes.length; i++) {
            const child = el.childNodes[i];
            if (child.nodeName === 'bind') {
                this.do_bind = true;
            }
            if (child.nodeName === 'session') {
                this.do_session = true;
            }
        }
    }

    connect (jid, password, callback, wait) {
        this.worker.port.postMessage(['connect', { jid, password, wait }]);
    }

    reset () {
        this.features = [];
        this.do_session = false;
        this.do_bind = false;
        this.connected = false;
        this.handlers = {};

        this.worker.port.postMessage(['reset']);
        this._addSysHandler(el => this.saveStreamFeatures(el), null, 'stream:features');
    }

    async bind () {
        /**
         * Synchronous event triggered before we send an IQ to bind the user's
         * JID resource for this session.
         * @event _converse#beforeResourceBinding
         */
        await api.trigger('beforeResourceBinding', {'synchronous': true});
        this.worker.port.postMessage(['bind']);
    }

    flush () {
        this.worker.port.postMessage(['flush']);
    }

    static getHandlerId () {
        return `handler-${u.getUniqueId()}`;
    }

    /**
     *  Add a system level stanza handler.
     *
     *  This function is used to add a Strophe.Handler for the
     *  library code.  System stanza handlers are allowed to run before
     *  authentication is complete.
     *
     *  @param {Function} handler - The callback function
     *  @param {String} ns - The namespace to match
     *  @param {String} name - The stanza name to match
     *  @param {String} type - The stanza type attribute to match
     *  @param {String} id - The stanza id attribute to match
     */
    _addSysHandler (handler, ns, name, type, id) {
        const handler_id = SharedWorkerConnectionManager.getHandlerId();
        handler.id = handler_id;
        this.handlers[handler_id] = handler;
        this.worker.port.postMessage(['_addSysHandler', {handler_id, ns, name, type, id}]);
    }

    /**
     *  This function adds a stanza handler to the connection.  The
     *  handler callback will be called for any stanza that matches
     *  the parameters. Note that if multiple parameters are supplied,
     *  they must all match for the handler to be invoked.
     *
     *  The handler will receive the stanza that triggered it as its argument.
     *
     *  *The handler should return true if it is to be invoked again;
     *  returning false will remove the handler after it returns.*
     *
     *  As a convenience, the ns parameters applies to the top level element
     *  and also any of its immediate children.  This is primarily to make
     *  matching /iq/query elements easy.
     *
     *  Options
     *  ~~~~~~~
     *  With the options argument, you can specify boolean flags that affect how
     *  matches are being done.
     *
     *  Currently two flags exist:
     *
     *  - matchBareFromJid:
     *      When set to true, the from parameter and the
     *      from attribute on the stanza will be matched as bare JIDs instead
     *      of full JIDs. To use this, pass {matchBareFromJid: true} as the
     *      value of options. The default value for matchBareFromJid is false.
     *
     *  - ignoreNamespaceFragment:
     *      When set to true, a fragment specified on the stanza's namespace
     *      URL will be ignored when it's matched with the one configured for
     *      the handler.
     *
     *      This means that if you register like this:
     *      >   connection.addHandler(
     *      >       handler,
     *      >       'http://jabber.org/protocol/muc',
     *      >       null, null, null, null,
     *      >       {'ignoreNamespaceFragment': true}
     *      >   );
     *
     *      Then a stanza with XML namespace of
     *      'http://jabber.org/protocol/muc#user' will also be matched. If
     *      'ignoreNamespaceFragment' is false, then only stanzas with
     *      'http://jabber.org/protocol/muc' will be matched.
     *
     *  Deleting the handler
     *  ~~~~~~~~~~~~~~~~~~~~
     *  The return value should be saved if you wish to remove the handler
     *  with deleteHandler().
     *
     *  @param {Function} handler - The user callback.
     *  @param {String} ns - The namespace to match.
     *  @param {String} name - The stanza name to match.
     *  @param {String|Array} type - The stanza type (or types if an array) to match.
     *  @param {String} id - The stanza id attribute to match.
     *  @param {String} from - The stanza from attribute to match.
     *  @param {String} options - The handler options
     *  @returns {String} handler_id - A reference to the handler that can be used to remove it.
     */
    addHandler (handler, ns, name, type, id, from, options) {
        const handler_id = SharedWorkerConnectionManager.getHandlerId();
        handler.id = handler_id;
        this.handlers[handler_id] = handler;
        this.worker.port.postMessage(['addHandler', {handler_id, ns, name, type, id, from, options}]);
        return handler_id;
    }

    /**
     *  Delete a stanza handler for a connection.
     *
     *  This function removes a stanza handler from the connection.  The
     *  handRef parameter is *not* the function passed to addHandler(),
     *  but is the reference returned from addHandler().
     *
     *  @param {Strophe.Handler} handRef - The handler reference.
     */
    deleteHandler (handler) {
        const handler_id = handler.id
        delete this.handlers[handler_id];
        this.worker.port.postMessage(['deleteHandler', {handler_id}]);
    }
}
