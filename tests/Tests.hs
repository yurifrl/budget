import Budget (double)
import Test.Tasty (defaultMain, testGroup)
import Test.Tasty.HUnit (assertEqual, testCase)

main = defaultMain unitTests

unitTests =
  testGroup
    "Unit tests"
    [sample]

sample =
  testCase "Double of 4 is 8" $ assertEqual [] 8 (double 4)
