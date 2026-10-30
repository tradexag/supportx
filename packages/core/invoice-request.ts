/**
 * Does the customer ask to be sent an invoice? Deliberately narrow, because a hit
 * may lead to an automatic reply: an invoice word together with a wish to receive
 * it. Complaints about an invoice (wrong amount, change of address, double charge,
 * dunning) are not requests and stay with a person.
 */
const INVOICE_WORD = /(?<!\p{L})(rechnung|rechnungs(?:kopie|beleg|-?pdf)|invoice|vat invoice|beleg|quittung|faktura)(?!\p{L})/iu;
const WANTS_IT = /(?<!\p{L})(senden|schicken|zusenden|übersenden|uebersenden|zuschicken|zukommen|erhalten|bekommen|ben[öo]tige|brauche|fehlt|anfordern|bitte um|h[äa]tte gern|h[äa]tte ich gern|m[öo]chte|wo finde|herunterladen|download|send|need|request|copy|kopie)\p{L}*/iu;
const NOT_A_REQUEST = /(?<!\p{L})(falsch|fehlerhaft|korrigier|[äa]nder|storn|doppelt|zu viel|zuviel|abgebucht|mahnung|inkasso|nicht bezahlt|reklamation|wrong|incorrect|change|correct)\p{L}*/iu;

export function asksForInvoice(customerText: string): boolean {
  const text = customerText.slice(0, 3000);
  return INVOICE_WORD.test(text) && WANTS_IT.test(text) && !NOT_A_REQUEST.test(text);
}
