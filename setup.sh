#!/bin/bash

if [ -f config.ts ] || [ -f compose.yml ] || [ -d data ]; then
  echo "Existing config.ts, compose.yml, or data/ detected."
  read -p "Overwrite? This will destroy current config and data. (y/N) " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborting."
    exit 1
  fi
fi

cp config.ts.sample config.ts
cp compose.yml.sample compose.yml
cp -r sampledata data
sudo chown 100:100 data/nostr/data

# create network
docker network create net 

# Create the data directory
mkdir -p ./data/tigerbeetle

# Initialize the data file
docker run --rm \
  --privileged \
  -v $(pwd)/data/tigerbeetle:/data \
  ghcr.io/tigerbeetle/tigerbeetle:latest \
  format --cluster=0 --replica=0 --replica-count=1 /data/0_0.tigerbeetle

  
docker-compose build --no-cache app
docker compose up -d
docker run -v $(pwd):/home/bun/app --entrypoint bun asoltys/coinos-server i
docker exec bc bitcoin-cli createwallet coinos
docker exec bc bitcoin-cli rescanblockchain
docker exec bc bitcoin-cli generatetoaddress 500 $(docker exec bc bitcoin-cli getnewaddress "" "p2sh-segwit")
docker exec lq elements-cli createwallet coinos
docker exec lq elements-cli rescanblockchain
docker exec lq elements-cli generatetoaddress 500 $(docker exec lq elements-cli getnewaddress)
# usdt
docker exec lq elements-cli -rpcwallet=coinos issueasset 1000000 0 false
