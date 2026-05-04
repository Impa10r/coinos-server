#!/bin/sh
for i in 1 2 3 4 5; do
  wget -q -O- --post-data='{"txid": "'$1'", "wallet": "'$2'", "type": "bitcoin", "secret": "YOUR_ADMINPASS"}' --header='Content-Type:application/json' 'http://app:3119/confirm' && exit 0
  sleep $i
done
echo "confirm failed for $1 after retries"
exit 1
