// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * Names Giac 1.9.0 reserves (a command, keyword or constant) that the
 * handheld leaves free for a user: Define area(x)=x^3 then area(2) was 0
 * (Giac's area), line(2) crashed, si (French "if") and fi couldn't be
 * stored. Each is renamed name_ on the way in and back on the way out
 * (translate.ts RENAME_IN). Found by trying name:=7, name+1, name(x):=x+1 and
 * name(2), one statement at a time, for every identifier in Giac's binary,
 * keeping those that failed and that the parser reads as a user's name
 * (not one of the handheld's own commands). sqrt is left out: the handheld
 * takes it as √. 1176 names.
 */
export const GIAC_RESERVED = (
  "a2q abcuv about abscissa acos acos2asin acos2atan acosh acot acoth acsc acyclic adaptive add additionally addr " +
  "addtable affix alg algebraic algsubs algvar alog10 alors altitude andsto angleat angleatraw animate animate3d " +
  "animation append apply arc arccosh arccot arccsc archive arcsec arcsinh arctanh area areaat areaatraw areaplot " +
  "arg args array arrivals asc asec asin asin2acos asin2atan asinh assert assign assume at atan atan2 atan2acos " +
  "atan2asin atanh atrig2ln autosimplify avance axes axesfont axis back background backquote backward bandwidth " +
  "bareiss barplot barycenter base basis batons begin bernoulli betad betavariate bezier bezoutian bin binomial " +
  "binprint bins bipartite bisector bitand bitmap bitnot bitor bitxor black blanc bleu bloc blockmatrix blue bool " +
  "border boxcar boxwhisker break breakpoint brown bspline bvpsolve by c1oc2 c1op2 camembert cap case caseval cat " +
  "catch cauchy cauchyd cd cdf cdfplot ceil cell center center2interval cfsolve changebase channels chinrem " +
  "chisquare chisquared chisquaret choice cholesky choosebox chr chrem circle circumcenter circumcircle classes " +
  "clear clearscreen click close cluster coeff coeffs col collect color colormap colspace colswap comb combine " +
  "comment companion compare complement complex complexroot concat cond condensation cone confidence confrac " +
  "conic connected cont contains content continue contourplot convert convert3d convertir convex convexhull " +
  "convolution coordinates coords copy copysign correlation cos2sintan cote covariance cp cpartfrac cpp cprint " +
  "crationalroot crayon createwav critical cross crossproduct csv2gen cube cumsum curl curvature curve cyan " +
  "cycle2perm cycleinv cycles2permu cyclotomic cylinder dayofweek de debug decrement default degree degrees del " +
  "delcols delrows deltalist denom densityplot departures derive deriver developper dfc dfc2f diff digraph " +
  "dijkstra directed discreted discriminant display disque distance distance2 distanceat distanceatraw div " +
  "divcrement divergence divide divis divisors divmod divpc do dodecahedron dot dotprod double downto droit " +
  "dsolve dtype duration dwt e2r ecef2geodetic ecris edges efface egcd egv egvl eigenvals eigenvalues " +
  "eigenvectors eigenvects element elif eliminate ellipse emd end entry envelope epaisseur epsilon epsilon2zero " +
  "equal equal2diff equal2list equation erase erase3d erf erfc erfs error esac et eval evala evalb evalc evalf " +
  "evalfa evalm even evolute exbisector excenter excircle execute exp2list exp2pow exp2trig expexpand expln " +
  "expln2trig expm1 exponential exponentiald export expovariate expression extend extrema ezgcd f2nd faces " +
  "factorial factoriser factors faddeev fadeev faire faux fclose fcoeff fdistrib feuille ffaire ffonction fft " +
  "ffunction fi fieldplot filled filter find findhelp fisher fisherd fitdistr fitpoly fitspline flatten flatten1 " +
  "float float2rational fmod foldl foldr fonction font fopen format forward fourier fpour fprint frac fracmod " +
  "frames frenet frequencies frexp from froot fsi fsolve ftantque fullparfrac funcplot function fxnd galoisconj " +
  "gammad gammavariate gauche gauss gauss15 gaussjord gaussquad gbasis gcdex genpoly geo2d geo3d geodetic2ecef " +
  "geometric ggbalt ggbsort giac girth global gold gomme grad gramschmidt graph graph2tex graph3d2tex graphe " +
  "graphe3d greduce green grey grid groebner groupermu hadamard halftan halt hamdist harmonic has hasard head " +
  "heading heapify heappop heappush help hermite hessenberg hessian heugcd hex hexagon hexprint hht hideturtle " +
  "highpass hilbert histogram hold homogeneize homothety horner hp38 hsv hsv2rgb hyp2exp hyperbola hyperplan " +
  "hypersphere hypersurface iabcuv ibasis ibpdv ibpu icdf ichinrem ichrem icomp icontent icosahedron id " +
  "identifier idivis idn idwt iegcd ifactor ifactors ifft ifourier ifte igamma igcd igcdex ihermite ilaplace im " +
  "image imfplot implicitdiff implicitplot implicitplot3d in incenter incircle increment indets index " +
  "inequationplot inertia innertln input inputform insert insmod instfreq instphase int integer integrate " +
  "integrer inter interactive interp intersect interval interval2center inv inverse inverser inversion invlaplace " +
  "invztrans iquo iquorem iquosto iratrecon irem iremsto isfinite isinf ismith isnan isobarycenter isolve isom " +
  "isopolygon isposdef istft ithprime jaune javascript join jordan jump jusqua jusque kde ker kernel keyboard " +
  "keydown kill kmeans kolmogorovd kolmogorovt kovacicsols kspaths l1norm l2norm label labeldirections labelfont " +
  "labels lagrange laguerre laplace laplacian latex lcoeff ldegree ldexp ldl leafsize legend legendre len length " +
  "let levenshtein lgamma lgcd lhs limite lin linabs linalg line lineariser linestyle linfnorm link2giac linspace " +
  "linstep lis list list2exp list2mat listplot lll lname lncollect lnexpand localbloc locate locus log10 log1p " +
  "log2 logb logic2set logistic lower lowpass lpsolve ls lsmod lsq lu lvar magenta makelist makemat makemod " +
  "makesuite makevector mantissa map maple2mupad maple2xcas markov mat2list mathml matpow matrix maxflow maximize " +
  "maxnorm member mgf midpoint minimax minimize minus mixdown mkdir mkisom mksa modf modgcd modp modresultant " +
  "mods momentum monotonic more moustache moyal moyenne mul multcrement multinomial multiply mupad2maple " +
  "mupad2xcas mycielski navy ncols neg negbinomial negint neighbors newton next nextperm nextprime nlpsolve " +
  "nodisp noir non nonnegint nonposint nop nops normal normald normalize normalt normalvariate nprimes nrows " +
  "nstep nullspace numdiff numer numpoints numtheory octahedron octprint od odd odeplot odesolve of olive oo op " +
  "open operator option orange order ordinate orsto orthocenter orthogonal otherwise ou output p1oc2 p1op2 pa2b2 " +
  "pade parabola parallel parallelepiped parallelogram parameq parameter paramplot parfrac pari part partfrac pas " +
  "pcar pcoef pcoeff pencolor pendown penup perimeter perimeterat perimeteratraw period periodic perm perminv " +
  "permu2cycles permu2mat permuorder perpendicular peval pink pivot pixoff pixon planar plane playsnd plex plot " +
  "plot3d plotarea plotcdf plotcontour plotdensity plotfield plotfunc plotimf plotimplicit plotinequation " +
  "plotlist plotmatrix plotode plotparam plotpolar plotproba plotseq plotspectrum plotwav pmin pnt point point2d " +
  "point3d pointer poisson polar2rectangular polarplot pole poly2symb polygamma polygon polygonplot " +
  "polygonscatterplot polyhedron polynom pop posint position potential pour pow pow2exp powermod powerpc " +
  "powexpand powmod powsto prediction prediction95 prepend preval prevperm prevprime primpart print printf " +
  "printpow prism proc program projection proot psrgcd ptayl purge purple pwd pyramid python q2a qr quadrant1 " +
  "quadrant2 quadrant3 quadrant4 quadric quadrilateral quantile quartile1 quartile3 quartiles quaternion quest " +
  "quo quorem quote r2e radians radius radius2 ramene randbetad randbinomial randchisquare randchisquared randexp " +
  "randfisher randfisherd randgammad randgeometric randmarkov randmatrix randmultinomial randnormald random " +
  "randperm randpoisson randpoly randrange randstudent randstudentd randvar randvector randweibulld range rank " +
  "ranm ranv ratinterp rational rationalroot ratnormal rdiv re reachable read read16 read32 readrgb readwav " +
  "realproot realroot reciprocation rectangle rectangular2polar rectangular2spherical recule red redim reflection " +
  "regroup rem remove rempli reorder repeat repete repeter replace resample residue resolution resoudre restart " +
  "resultant retourne reverse revert revlex revlist rgb rgb2hsv rgb2xyz rhombus rhs risch rm rmbreakpoint rmmod " +
  "rms rmwatch romberg rombergm rombergt rond rootof roots rotatesto rotation rouge row rowspace rpn rsolve rur " +
  "same sample samplerate saute sauve scale scaleadd scaling scatterplot schur segment select seqplot seqsolve " +
  "set set2logic shiftsto show showturtle shuffle si sialorssinon signature signe similarity simp2 simplifier " +
  "simplify simpson sin2costan sinc sincos singular sinon size sizes skip sleep slope slopeat slopeatraw smith " +
  "smod snedecor snedecord somme sommet sort sorted sortperm soundsec sphere spherical2rectangular splice spline " +
  "split spread2mathml spreadsheet spring sq sqrfree square srand sst stack stddev stddevp step stereo2mono " +
  "stft sto str strip student studentd studentt sturm sturmab sturmseq style subgraph submatrix subs subsop subst " +
  "substituer subtype suppress surd svd svg svl swapcol swaprow switch sylvester symb2poly symbol symbolsize " +
  "syst2mat syzygy table tablefunc tableseq tabsign tabvar tail tan2cossin2 tan2sincos tan2sincos2 tangent " +
  "tangente tantque tar tchebyshev1 tchebyshev2 tcoeff tcollectsin tdeg teal testfunc tests tetrahedron textinput " +
  "thickness thiele threads threshold throw tickmarks time title titlefont titre tlin to tonnetz topology towards " +
  "tpsolve trail trail2edges train trames tran translation transpose trapeze trapezoid tree tri triangle trier " +
  "trig trig2exp trigcos trigexpand triginterp trigsimplify trigsin trigtan trim trn trunc truncate try tsimplify " +
  "tstep type ufactor ugamma unapply unarchive unassign unfactored uniform uniformd union unquote until upper " +
  "usimplify ustep valuation vandermonde var variance vector vers version vert vertices view violet virgule " +
  "volume vpotential vrai vstep watch weibull weibulld weibullvariate weighted weights whattype white wilcoxonp " +
  "wilcoxons wilcoxont write write16 write32 writergb writewav xcas xorsto xstep xtickmarks xyz2rgb xyztrange " +
  "yellow ystep zip znorder znprimroot zstep ztrans "
)
  .trim()
  .split(" ");
