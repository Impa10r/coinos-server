import mqtt from "mqtt";
import config from "$config";

export default mqtt.connect(config.mqttUrl, config.mqtt);
