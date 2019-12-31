module BudgetTest where

import Test.Tasty
import Test.Tasty.HUnit
import Test.Tasty.SmallCheck as SC

import Budget

main = defaultMain tests

tests :: TestTree
tests = testGroup "Testing Budget" [unitTests]

unitTests = testGroup "Tests (run via HUnit)"
    [ testCase "compare" $
        [1, 2, 3] `compare` [1, 2] @?= GT
    , testCase "length" $
        length [1, 2, 3] @?= 3
    ]
