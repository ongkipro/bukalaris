import { z } from "zod";

// Response shapes observed against the real API (docs/tracks/shipping.md,
// "Observed contract evidence"). Every object is `loose`: unknown fields are
// kept, only the fields this package reads are typed.

/** Standard envelope. `data` is validated per operation. */
export const envelopeSchema = z.looseObject({
  success: z.boolean().optional(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  errorsFront: z.string().optional(),
  code: z.string().optional(),
});

/** One row of `GET /address/search`. `_id` is the AREA id used as origin/destination. */
export const areaSchema = z.looseObject({
  _id: z.string().min(1),
  PROVINCE_NAME: z.string().optional(),
  CITY_NAME: z.string().optional(),
  DISTRICT_NAME: z.string().optional(),
  SUBDISTRICT_NAME: z.string().optional(),
  ZIP_CODE: z.string().optional(),
});
export const areaListSchema = z.array(areaSchema);
export type MengantarArea = z.infer<typeof areaSchema>;

/** One pickup address of `GET /address`. `PICKUP_AUTOFILL` is the area id; PIC name/phone are not read. */
export const pickupAddressSchema = z.looseObject({
  _id: z.string().min(1),
  PICKUP_NAME: z.string().optional(),
  PICKUP_AUTOFILL: z.string().optional(),
});
export const pickupAddressListSchema = z.array(pickupAddressSchema);

/** One courier entry of an estimate map. ETD and price breakdown are optional per courier. */
export const courierRateSchema = z.looseObject({
  price: z.number().optional(),
  estimatedPrice: z.number().optional(),
  estimatedSpecialPrice: z.number().optional(),
  codFee: z.number().optional(),
  discount: z.number().optional(),
  unsupported: z.boolean().nullish(),
  unsupported_cod: z.boolean().nullish(),
  unsupportedOriginSpx: z.boolean().nullish(),
  estimate_delivery: z.string().optional(),
  estimatedDate: z.string().optional(),
});
export type CourierRate = z.infer<typeof courierRateSchema>;
/** `courier=all` and the 3PL estimate return a map keyed by courier estimate key, not an array. */
export const rateMapSchema = z.record(z.string(), courierRateSchema);

/** `GET /getReceiverScoreByNumberUser`: shape is account-specific; keep it loose. */
export const receiverScoreSchema = z.looseObject({}).nullable();

/**
 * One created order of `POST /order` (`data[]`), per the partner spec (docs 01 §8, openapi
 * `CreateOrderResponse`). UNVERIFIED until an observed, sanitized write is recorded (T-39):
 * `cnote_no` is null and `isPaid` false when the account balance was insufficient.
 */
export const createdOrderSchema = z.looseObject({
  ORDER_ID: z.string().optional(),
  cnote_no: z.string().nullish(),
  status: z.string().optional(),
  statusCategory: z.string().optional(),
  isPaid: z.boolean().optional(),
  batch_id: z.string().optional(),
  batch: z.string().optional(),
  error: z.unknown().optional(),
});
export const createOrderResponseSchema = z.looseObject({
  success: z.boolean().optional(),
  batch: z.string().optional(),
  batch_id: z.string().optional(),
  courier: z.string().optional(),
  errors: z.array(z.unknown()).optional(),
  data: z.array(createdOrderSchema).optional(),
});
export type CreatedOrder = z.infer<typeof createdOrderSchema>;

/** One tracked order of `GET /order` (openapi `TrackingInfo`); only the fields read are typed. */
export const trackingInfoSchema = z.looseObject({
  ORDER_ID: z.string().optional(),
  cnote_no: z.string().nullish(),
  status: z.string().optional(),
  statusCategory: z.string().optional(),
  isPaid: z.boolean().optional(),
  history: z.array(z.looseObject({ date: z.string().optional(), desc: z.string().optional() })).optional(),
});
export type TrackingInfo = z.infer<typeof trackingInfoSchema>;
/** `GET /order` data: UNVERIFIED whether a list, a paginated object or one order; normalised by the adapter. */
export const orderLookupSchema = z.unknown();
