// backend/utils/pricing.js
// Shared line-item price rules for quotations and orders.

// A price adjustment reason is only needed when a CATALOG item's price was changed. Custom lines have no
// catalog price (base price 0, or whatever was typed), so any price on them is not an adjustment.
export function isPriceAdjusted(item, basePrice, finalUnitPrice) {
  return Boolean(item.productServiceId) && !item.isCustom && Math.abs(finalUnitPrice - basePrice) > 0.001;
}

// "Tarpaulin (3x6 ft)" for messages and audit entries
export function itemLabel(name, variant) {
  return variant ? `${name} (${variant})` : name;
}
