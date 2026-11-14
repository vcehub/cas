// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * Built-in command names. The handheld prints these upright and a user's own
 * functions (cub(2), f1(x)) in italic, like variables.
 */
export const BUILTINS = new Set(
  (
    "solve factor expand zeros completeSquare nSolve propFrac getNum getDenom comDenom comden round iPart fPart sign " +
    "mod floor ceiling conj real imag angle abs lcm gcd remain isPrime polyRoots cPolyRoots polyRemainder " +
    "polyQuotient polyGcd polyCoeffs polyDegree tExpand tCollect cSolve cFactor cZeros left right mid d fMin fMax " +
    "tangentLine normalLine arcLen taylor series dominantTerm deSolve impDif nDerivative centralDiff nInt nfMin " +
    "nfMax nPr nCr rand randInt randBin randNorm randSamp normPdf normCdf invNorm tPdf tCdf invt binomPdf binomCdf " +
    "invBinom invBinomN geomPdf geomCdf poissPdf poissCdf min max mean median sum product stDevSamp varSamp " +
    "stDevPop varPop cumulativeSum seq augment newMat identity diag randMat subMat colAugment constructMat det ref " +
    "rref simult norm rowNorm colNorm dim rowDim colDim rowSwap rowAdd mRow mRowAdd trace eigVl eigVc charPoly " +
    "unitV crossP dotP sin cos tan csc sec cot sinh cosh tanh arcsin arccos arctan ln log exp approx exact root " +
    "piecewise when limit lim integral derivative expr string list▶mat mat▶list linSolve domain countIf sumIf " +
    "frequency nextprim tvmFV tvmPV tvmPmt tvmN tvmI eff nom amortTbl bal ΣInt ΣPrn not sin⁻¹ cos⁻¹ tan⁻¹ csc⁻¹ sec⁻¹ cot⁻¹ sinh⁻¹ cosh⁻¹ tanh⁻¹"
  ).split(" "),
);
