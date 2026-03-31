'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const connectionTimeoutMs = 15 * 1000;
const portRetryDelayMs = 30 * 1000;

// Types, units of TIC fields
// TODO: add descriptions with translations
// TODO: add tri-phase
// TODO: add 'standard' mode
const ticStateCommon = {
    ADCO: { type: 'string' },
    OPTARIF: { type: 'string' },
    ISOUSC: { type: 'number', unit: 'A', role: 'value.current' },
    BASE: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },

    HCHC: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },
    HCHP: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },

    EJPHN: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },
    EJPHPM: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },

    BBRHCJB: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },
    BBRHPJB: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },
    BBRHCJW: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },
    BBRHPJW: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },
    BBRHCJR: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },
    BBRHPJR: { type: 'number', unit: 'Wh', role: 'value.power.consumption' },

    PEJP: { type: 'number' /* In minutes */ },

    PTEC: { type: 'string' },
    DEMAIN: { type: 'string' },

    IINST: { type: 'number', unit: 'A', role: 'value.current' },
    ADPS: { type: 'number', unit: 'A', role: 'value.current' },
    IMAX: { type: 'number', unit: 'A', role: 'value.current' },

    PAPP: { type: 'number', unit: 'VA' }, // TODO: no role for VA documented

    HHPHC: { type: 'string' },
    MOTDETAT: { type: 'string' },
};

class Linky extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'linky',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.port = null;
        this.adco = null;
        this.connectionTimeout = null;
        this.portRetryTimer = null;
        this.knownObjects = [];
    }

    // Set/reset connection
    setConnected(connected) {
        this.setState('info.connection', connected, true);
        if (!connected) {
            this.adco = null;
            if (this.connectionTimeout) {
                this.clearTimeout(this.connectionTimeout);
                this.connectionTimeout = null;
            }
        }
    }

    // Set connection timer
    startConnectionTimer() {
        if (this.connectionTimeout) {
            this.clearTimeout(this.connectionTimeout);
        }
        this.connectionTimeout = this.setTimeout(async () => {
            this.connectionTimeout = null;
            this.log.warn(`Connection timeout for ${this.adco}`);
            this.setConnected(false);
            this.closePort(() => {
                this.retryOpen();
            });
        }, connectionTimeoutMs);
    }

    closePort(callback) {
        if (this.portRetryTimer) {
            this.clearTimeout(this.portRetryTimer);
            this.portRetryTimer = null;
        }

        if (this.port) {
            this.port.close(error => {
                if (error) {
                    callback(error);
                } else {
                    this.log.info(`Closed serial port: ${this.config.serialPort}`);
                    this.port = null;
                    callback();
                }
            });
        } else {
            callback();
        }
    }

    retryOpen() {
        this.log.debug(`Retrying port open ${this.config.serialPort} in ${portRetryDelayMs}ms`);
        this.portRetryTimer = this.setTimeout(() => {
            this.portRetryTimer = null;
            this.openPort();
        }, portRetryDelayMs);
    }

    openPort() {
        this.log.info(`Opening serial port: ${this.config.serialPort}`);

        try {
            this.port = new SerialPort({
                path: this.config.serialPort,
                baudRate: 1200,
                dataBits: 7,
                parity: 'even',
            });

            this.port.on('error', error => {
                this.log.error(`Serial port error: ${error.message}`);
                this.port = null;
                this.setConnected(false);
                this.retryOpen();
            });

            this.port.on('open', () => {
                this.log.debug('Serial port opened');
                this.parsePort();
            });
        } catch (error) {
            this.log.error(`Failed to open serial port ${this.config.serialPort}: ${error.message}`);
            this.retryOpen();
        }
    }

    async checkAndSetState(name, value) {
        // Create channel for ADCO if we haven't done already.
        if (!this.knownObjects.includes(this.adco)) {
            this.log.debug(`Creating channel: ${this.adco}`);
            try {
                await this.setObjectNotExists(this.adco, {
                    type: 'channel',
                    common: {
                        name: this.adco,
                    },
                    native: {},
                });
                this.knownObjects.push(this.adco);
            } catch (error) {
                this.log.error(`Failed to create channel for ${this.adco}: ${error.message}`);
            }
        }

        const stateName = `${this.adco}.${name}`;
        // Create state for value if we haven't done already.
        if (!this.knownObjects.includes(stateName)) {
            this.log.debug(`Creating state: ${stateName}`);
            try {
                await this.setObjectNotExists(stateName, {
                    type: 'state',
                    common: ticStateCommon[name],
                    native: {},
                    // TODO: other attributes?
                });
                this.knownObjects.push(stateName);
            } catch (error) {
                this.log.error(`Failed to create state for ${stateName}: ${error.message}`);
            }
        }

        // Set state value only if it has changed.
        try {
            this.setStateChanged(stateName, {
                ack: true,
                val: ticStateCommon[name].type === 'number' ? Number(value) : value,
            });
        } catch (error) {
            this.log.error(`Failed to set state value ${stateName} -> ${value}: ${error.message}`);
        }
    }

    parsePort() {
        if (!this.port || !this.port.isOpen) {
            this.log.error('Cannot parse port because it is not open');
        } else {
            const parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
            parser.on('data', async data => {
                // data is a string
                this.log.silly(data);

                const parts = data.split(/\s+/);
                if (parts.length != 4) {
                    this.log.warn(`Unexpected data: ${parts.length} parts (expected 4)`);
                } else {
                    const name = parts.shift();
                    const value = parts.shift();
                    const checksum = parts.shift();
                    const theirChecksumInt = checksum.charCodeAt(0);

                    // From Teleinfo document, how to calculate checksum:
                    //
                    // Calculate the sum "S1" of all characters from the beginning of the "Label" field up
                    // to and including the delimiter between the "Data" and "Checksum" fields;
                    //
                    // This sum is truncated to 6 bits (this operation is performed using a logical AND with 0x3F);
                    //
                    // To obtain the checksum result, add the previous result S2 to 0x20

                    let ourChecksumInt = 0;
                    for (let lp = 0; lp < name.length + value.length + 1; lp++) {
                        ourChecksumInt += data.charCodeAt(lp);
                        this.log.silly(`checksum: char ${lp} is ${data.charCodeAt(lp)} so far ${ourChecksumInt}`);
                    }
                    ourChecksumInt = (ourChecksumInt & 0x3f) + 0x20;
                    this.log.silly(`checksum complete: ${ourChecksumInt}`);

                    if (ourChecksumInt != theirChecksumInt) {
                        this.log.warn(`Checksum error. Ours (${ourChecksumInt}) does not match ${theirChecksumInt})`);
                    } else {
                        if (ticStateCommon[name] === undefined) {
                            // We don't know what this field is so ignore it
                            this.log.warn(`Unknown label (ignoring): ${name}`);
                        } else if (name === 'ADCO') {
                            // Store this as last ADCO seen which all following fields belong to.
                            if (this.adco !== value) {
                                // Only log if changed.
                                this.adco = value;
                                this.log.info(`Found ADCO '${this.adco}'`);
                                this.setConnected(true);
                            }
                            // If we got ADCO, the connection must be alive, so reset the timer.
                            this.startConnectionTimer();
                        } else if (this.adco) {
                            this.checkAndSetState(name, value);
                        } else {
                            this.log.warn(`Received ${name} ${value} but no ADCO known yet`);
                        }
                    }
                }
            });
        }
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.setConnected(false);
        if (!this.config.serialPort) {
            this.log.error('No serial port configured! Please define the serial port in adapter settings.');
            this.disable();
        } else {
            this.openPort();
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            this.closePort(callback);
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new Linky(options);
} else {
    // otherwise start the instance directly
    new Linky();
}
