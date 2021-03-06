import {
  BlockAllegra,
  BlockAlonzo,
  BlockMary,
  BlockShelley,
  Point,
} from '@cardano-ogmios/schema';
import { ActivityType, Schema } from '../types';
import S from '@emurgo/cardano-serialization-lib-nodejs';
import _ from 'lodash';

const CONTRACT_ADDRESS =
  'addr1wx468s53gytznzs5dt6hmq2kk9vr7xplcpwq4fywa9d7cug7fd0ed';
const SCRIPT_HASH = 'aba3c2914116298a146af57d8156b1583f183fc05c0aa48ee95bec71';
const BID_POLICY = '6bec713b08a2d7c64baa3596d200b41b560850919d72e634944f2d52';
const SPACEBUDZ_POLICY =
  'd5e6bf0500378d4f0da4e8dde6becec7621cd8cbf5cbb9b87013d4cc';
const START_BID_HASH =
  'f7f2f57c58b5e4872201ab678928b0d63935e82d022d385e1bad5bfe347e89d8';

const REDEEMER = {
  Buy: { data: '2GaCAIA=', type: 0 },
  Sell: { data: '2GaCAYA=', type: 1 },
  Cancel: { data: '2GaCA4A=', type: 3 },
};

const DATUM_LABEL = 405;
const ADDRESS_LABEL = 406;

enum DATUM_TYPE {
  StartBid,
  Bid,
  Listing,
}

const mapDatumType = (type: DATUM_TYPE) => {
  const m = {
    [DATUM_TYPE.StartBid]: 'startBid',
    [DATUM_TYPE.Bid]: 'bid',
    [DATUM_TYPE.Listing]: 'listing',
  };
  return m[type];
};

const filterIndexAndContent = (array, f) => {
  const result = [];
  for (let i = 0; i < array.length; i++) {
    if (f(array[i])) {
      result.push({ index: i, content: array[i] });
    }
  }
  return result;
};

const getTradeDetails = (
  datumHex: string,
): { type: DATUM_TYPE; budId: number; amount: BigInt } => {
  const datum = S.PlutusData.from_bytes(
    Buffer.from(datumHex, 'hex'),
  ).as_constr_plutus_data();
  const type = parseInt(datum.alternative().to_str());
  const tradeDetails = datum.data().get(0).as_constr_plutus_data().data();
  return {
    type,
    budId: parseInt(Buffer.from(tradeDetails.get(1).as_bytes()).toString()),
    amount: BigInt(tradeDetails.get(2).as_integer().as_u64().to_str()),
  };
};

const getAddress = (addressHex: string): string =>
  S.Address.from_bytes(Buffer.from(addressHex, 'hex')).to_bech32();

const getRedeemers = (transaction) => {
  const redeemers = transaction.witness.redeemers;
  const result = [];
  if (!transaction.witness.scripts[SCRIPT_HASH]) return [];
  for (const index in redeemers) {
    const redeemer = redeemers[index].redeemer;
    if (redeemer == REDEEMER.Sell.data) result.push(REDEEMER.Sell.type);
    else if (redeemer == REDEEMER.Buy.data) result.push(REDEEMER.Buy.type);
    else if (redeemer == REDEEMER.Cancel.data)
      result.push(REDEEMER.Cancel.type);
  }
  return result;
};

const getDatum = (transaction, datumType: DATUM_TYPE) => {
  const datums = transaction.witness.datums;
  for (const datumHash in datums) {
    const datum = Buffer.from(datums[datumHash], 'base64').toString('hex');
    try {
      const tradeDetails = getTradeDetails(datum);
      if (tradeDetails.type == datumType) return tradeDetails;
    } catch (e) {}
  }
  return null;
};

const updateActivity = ({
  db,
  activityType,
  budId,
  lovelace,
  slot,
}: {
  db: Schema;
  activityType: ActivityType;
  budId: number;
  lovelace: BigInt;
  slot: number;
}) => {
  db.activity.unshift({ type: activityType, budId, lovelace, slot });
  if (db.activity.length > 10) db.activity.pop();
};

const setSpaceBudTrade = ({
  db,
  type,
  budId,
  owner,
  amount,
  slot,
}: {
  db: Schema;
  type: DATUM_TYPE;
  budId: number;
  owner: string;
  amount: BigInt;
  slot: number;
}) => {
  updateActivity({
    db,
    budId,
    lovelace: amount,
    slot,
    activityType:
      type === DATUM_TYPE.Bid ? ActivityType.bid : ActivityType.listed,
  });
  _.set(db.spacebudz, `[${budId}].trade.v1[${mapDatumType(type)}]`, {
    owner,
    amount,
    slot,
  });
};

const setSpaceBudLastSale = ({
  db,
  type,
  budId,
  slot,
}: {
  db: Schema;
  type: DATUM_TYPE;
  budId: number;
  slot: number;
}) => {
  const amount = db.spacebudz[budId].trade.v1[mapDatumType(type)].amount;

  updateActivity({
    db,
    budId,
    lovelace: amount,
    slot,
    activityType:
      type === DATUM_TYPE.Bid ? ActivityType.sold : ActivityType.bought,
  });

  // update SpaceBud history
  if (!db.spacebudz[budId]?.history)
    _.set(db.spacebudz, `[${budId}].history`, []);

  db.spacebudz[budId].history.unshift({
    amount,
    slot,
  });

  // update topSales
  if (db.topSales.length < 10) {
    db.topSales.push({
      slot,
      amount,
      budId,
    });
    db.topSales.sort((a, b) =>
      a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0,
    ); // sort amount in DESC order
  } else {
    const reverseTopSales = [...db.topSales].reverse();
    const index = reverseTopSales.findIndex((sale) => sale.amount < amount);
    if (index !== -1) {
      reverseTopSales[index] = { slot, amount, budId };
      reverseTopSales.sort((a, b) =>
        a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0,
      ); // sort amount in DESC order
      db.topSales = reverseTopSales;
    }
  }

  // update volume
  db.totalVolume += amount;

  // update count
  db.totalSales += 1;

  delete db.spacebudz[budId].trade.v1[mapDatumType(type)];
};

const setSpaceBudCancel = ({
  db,
  type,
  budId,
  slot,
}: {
  db: Schema;
  type: DATUM_TYPE;
  budId: number;
  slot: number;
}) => {
  updateActivity({
    db,
    budId,
    lovelace: db.spacebudz[budId].trade.v1[mapDatumType(type)].amount,
    slot,
    activityType:
      type === DATUM_TYPE.Bid
        ? ActivityType.canceledBid
        : ActivityType.canceledListing,
  });
  delete db.spacebudz[budId].trade.v1[mapDatumType(type)];
};

export const marketplaceV1 = (
  block: BlockShelley | BlockAllegra | BlockMary | BlockAlonzo,
  point: Point,
  db: Schema,
) => {
  const transactions = block.body;
  transactions.forEach((transaction) => {
    const outputs = transaction.body.outputs;
    const metadata = transaction.metadata?.body?.blob;
    const contractOutputs = filterIndexAndContent(
      outputs,
      (output) =>
        metadata?.[DATUM_LABEL] &&
        metadata?.[ADDRESS_LABEL] &&
        output.address === CONTRACT_ADDRESS &&
        output.datum !== START_BID_HASH &&
        Object.keys(output.value.assets).some(
          (asset) =>
            (asset.startsWith(SPACEBUDZ_POLICY) ||
              asset.startsWith(BID_POLICY)) &&
            output.value.assets[asset] >= 1n,
        ),
    );

    // check for sales and cancelling
    const redeemers = getRedeemers(transaction);
    redeemers.forEach((redeemer) => {
      if (redeemer == REDEEMER.Buy.type) {
        const tradeDetails = getDatum(transaction, DATUM_TYPE.Listing);
        setSpaceBudLastSale({
          db,
          budId: tradeDetails.budId,
          type: DATUM_TYPE.Listing,
          slot: point.slot,
        });
      } else if (redeemer == REDEEMER.Sell.type) {
        const tradeDetails = getDatum(transaction, DATUM_TYPE.Bid);
        setSpaceBudLastSale({
          db,
          budId: tradeDetails.budId,
          type: DATUM_TYPE.Bid,
          slot: point.slot,
        });
      } else if (redeemer == REDEEMER.Cancel.type) {
        let tradeDetails = getDatum(transaction, DATUM_TYPE.Bid);
        if (tradeDetails) {
          setSpaceBudCancel({
            db,
            budId: tradeDetails.budId,
            type: DATUM_TYPE.Bid,
            slot: point.slot,
          });
        } else {
          tradeDetails = getDatum(transaction, DATUM_TYPE.Listing);
          if (tradeDetails)
            setSpaceBudCancel({
              db,
              budId: tradeDetails.budId,
              type: DATUM_TYPE.Listing,
              slot: point.slot,
            });
        }
      }
    });

    // check for new listings and bids
    if (contractOutputs.length <= 0) return;
    contractOutputs.forEach(({ index, content }) => {
      const tradeDetails = getTradeDetails(metadata[405].map[index].v.bytes);
      const type = tradeDetails.type;
      const budId = tradeDetails.budId;
      const owner = getAddress(metadata[406].map[0].v.bytes);
      if (type == DATUM_TYPE.Bid) {
        setSpaceBudTrade({
          db,
          type,
          budId,
          owner,
          amount: BigInt(content.value.coins),
          slot: point.slot,
        });
      } else if (type == DATUM_TYPE.Listing) {
        setSpaceBudTrade({
          db,
          type,
          budId,
          owner,
          amount: tradeDetails.amount,
          slot: point.slot,
        });
      }
    });
  });
};
