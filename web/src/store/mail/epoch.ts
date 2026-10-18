/**
 * The current list window's generation.
 *
 * A full read (`refreshList`, or a fresh `query`) moves it, and so does any
 * change that takes rows off the screen -- `destroy`, or a `move` that removes
 * a row from the window (`moveToDestinations` reaches this through `move`): a
 * page that was already on its way drops its answer instead of appending over
 * the new window, and a list read computed before the change drops its answer
 * instead of putting the removed rows back on screen.
 */
let epoch = 0;

/** The window a read belongs to, read when its request is issued. */
export const currentEpoch = (): number => epoch;

/** A change that takes rows off the screen moves the window. */
export const moveEpoch = (): void => {
  epoch += 1;
};
