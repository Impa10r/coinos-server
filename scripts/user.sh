#!/usr/bin/env bash

docker exec -it db valkey-cli get "user:$1"